/**
 * Master keyring (SPEC §6). Keys come from the environment only:
 *   SHOPKIT_MASTER_KEY            base64, 32 bytes, used as version SHOPKIT_MASTER_KEY_VERSION
 *   SHOPKIT_MASTER_KEY_<n>        additional versions kept for decrypting older rows
 *   SHOPKIT_MASTER_KEY_VERSION    the version new secrets are wrapped with (default 1)
 */
export interface Keyring {
  readonly current: number;
  readonly keys: ReadonlyMap<number, Buffer>;
}

export class KeyringError extends Error {
  override name = "KeyringError";
}

const KEY_BYTES = 32;

export function parseKey(name: string, value: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new KeyringError(`${name} must be ${KEY_BYTES} bytes encoded as base64 (got ${key.length} bytes)`);
  }
  return key;
}

function parseVersion(name: string, value: string): number {
  if (!/^[1-9]\d{0,5}$/.test(value)) throw new KeyringError(`${name} must be a positive integer`);
  return Number(value);
}

export function loadKeyring(env: Record<string, string | undefined> = process.env): Keyring {
  const current = env.SHOPKIT_MASTER_KEY_VERSION
    ? parseVersion("SHOPKIT_MASTER_KEY_VERSION", env.SHOPKIT_MASTER_KEY_VERSION)
    : 1;
  const keys = new Map<number, Buffer>();

  for (const [name, value] of Object.entries(env)) {
    const match = /^SHOPKIT_MASTER_KEY_(\d+)$/.exec(name);
    if (!match || !value) continue;
    keys.set(parseVersion(name, match[1]!), parseKey(name, value));
  }
  if (env.SHOPKIT_MASTER_KEY) {
    const key = parseKey("SHOPKIT_MASTER_KEY", env.SHOPKIT_MASTER_KEY);
    const existing = keys.get(current);
    if (existing && !existing.equals(key)) {
      throw new KeyringError(
        `SHOPKIT_MASTER_KEY and SHOPKIT_MASTER_KEY_${current} are both set but differ`,
      );
    }
    keys.set(current, key);
  }
  if (!keys.has(current)) {
    throw new KeyringError(
      `No master key for version ${current}. Set SHOPKIT_MASTER_KEY (or SHOPKIT_MASTER_KEY_${current}).`,
    );
  }
  return { current, keys };
}

export function keyFor(keyring: Keyring, version: number): Buffer {
  const key = keyring.keys.get(version);
  if (!key) throw new KeyringError(`Master key version ${version} is not loaded`);
  return key;
}
