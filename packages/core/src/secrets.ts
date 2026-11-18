import { decryptSecret, encryptSecret, type EncryptedSecret, type Keyring } from "@shopkit/crypto";
import type { StoredSecret } from "@shopkit/db";

/** JSON-column form of an envelope-encrypted value (used for staff TOTP secrets). */
export function sealJson(payload: unknown, aad: string, keyring: Keyring): StoredSecret {
  const e = encryptSecret(payload, aad, keyring);
  return {
    ciphertext: e.ciphertext.toString("base64"),
    iv: e.iv.toString("base64"),
    authTag: e.authTag.toString("base64"),
    wrappedDek: e.wrappedDek.toString("base64"),
    dekIv: e.dekIv.toString("base64"),
    dekTag: e.dekTag.toString("base64"),
    keyVersion: e.keyVersion,
  };
}

export function toEncrypted(s: StoredSecret): EncryptedSecret {
  return {
    ciphertext: Buffer.from(s.ciphertext, "base64"),
    iv: Buffer.from(s.iv, "base64"),
    authTag: Buffer.from(s.authTag, "base64"),
    wrappedDek: Buffer.from(s.wrappedDek, "base64"),
    dekIv: Buffer.from(s.dekIv, "base64"),
    dekTag: Buffer.from(s.dekTag, "base64"),
    keyVersion: s.keyVersion,
  };
}

export function openJson<T>(s: StoredSecret, aad: string, keyring: Keyring): T {
  return decryptSecret<T>(toEncrypted(s), aad, keyring);
}

export const totpAad = (storeId: string, staffId: string) => `${storeId}|totp|staff|${staffId}`;
