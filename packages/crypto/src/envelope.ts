import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { keyFor, type Keyring } from "./keyring.js";

/**
 * Envelope encryption (SPEC §6): every secret gets its own random 32-byte DEK; the payload is
 * sealed with AES-256-GCM under the DEK with AAD = `store_id|kind|provider|mode`, and the DEK
 * is sealed with the master key. The DEK's AAD binds it to the row and the key version, so a
 * wrapped DEK copied to another row or relabelled with another version fails to open.
 */
export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
  dekIv: Buffer;
  dekTag: Buffer;
  keyVersion: number;
}

export interface AadParts {
  storeId: string;
  kind: string;
  provider: string;
  mode: string;
}

export class DecryptionError extends Error {
  override name = "DecryptionError";
  constructor() {
    super("Secret could not be decrypted (wrong key, wrong context or tampered data)");
  }
}

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

export function buildAad({ storeId, kind, provider, mode }: AadParts): string {
  for (const part of [storeId, kind, provider, mode]) {
    if (!part || part.includes("|")) throw new TypeError("AAD parts must be non-empty and contain no '|'");
  }
  return `${storeId}|${kind}|${provider}|${mode}`;
}

function dekAad(aad: string, version: number): Buffer {
  return Buffer.from(`dek|v${version}|${aad}`, "utf8");
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function open(key: Buffer, ciphertext: Buffer, iv: Buffer, tag: Buffer, aad: Buffer): Buffer {
  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

function wrapDek(dek: Buffer, aad: string, keyring: Keyring, version: number) {
  const sealed = seal(keyFor(keyring, version), dek, dekAad(aad, version));
  return { wrappedDek: sealed.ciphertext, dekIv: sealed.iv, dekTag: sealed.tag, keyVersion: version };
}

function unwrapDek(record: EncryptedSecret, aad: string, keyring: Keyring): Buffer {
  const key = keyFor(keyring, record.keyVersion);
  return open(key, record.wrappedDek, record.dekIv, record.dekTag, dekAad(aad, record.keyVersion));
}

export function encryptSecret(payload: unknown, aad: string, keyring: Keyring): EncryptedSecret {
  const dek = randomBytes(32);
  try {
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const sealed = seal(dek, plaintext, Buffer.from(aad, "utf8"));
    return {
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.tag,
      ...wrapDek(dek, aad, keyring, keyring.current),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptSecret<T = unknown>(record: EncryptedSecret, aad: string, keyring: Keyring): T {
  const dek = unwrapDek(record, aad, keyring);
  try {
    const plaintext = open(dek, record.ciphertext, record.iv, record.authTag, Buffer.from(aad, "utf8"));
    return JSON.parse(plaintext.toString("utf8")) as T;
  } finally {
    dek.fill(0);
  }
}

/** Re-wraps the DEK under another master key version. The payload ciphertext is untouched. */
export function rewrapSecret(
  record: EncryptedSecret,
  aad: string,
  keyring: Keyring,
  toVersion: number,
): EncryptedSecret {
  const dek = unwrapDek(record, aad, keyring);
  try {
    return { ...record, ...wrapDek(dek, aad, keyring, toVersion) };
  } finally {
    dek.fill(0);
  }
}
