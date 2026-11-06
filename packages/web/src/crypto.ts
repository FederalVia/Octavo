/**
 * Locked notes: end-to-end encryption of individual notes in the browser.
 *
 * - AES-256-GCM with a fresh random 96-bit IV for every save.
 * - The key is derived from the user's password with PBKDF2-SHA256 (600,000
 *   iterations) and a random 128-bit salt per note.
 * - Only the envelope is ever sent to the server. The password and plaintext
 *   stay in this browser tab's memory.
 *
 * File format (still a valid Markdown note, so other tools show a placeholder):
 *
 *   ---
 *   ultron-encrypted: v1
 *   ---
 *   # 🔒 Locked note
 *   …explanation…
 *   ```ultron-encrypted
 *   {"v":1,"alg":"AES-256-GCM","kdf":"PBKDF2-SHA256","iter":600000,"salt":"…","iv":"…","ct":"…"}
 *   ```
 */

export const KDF_ITERATIONS = 600_000;

export interface Envelope {
  v: 1;
  alg: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA256';
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

/** A derived key, cached in memory while a note is unlocked. */
export interface NoteKey {
  key: CryptoKey;
  salt: string;
  iter: number;
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password');
    this.name = 'WrongPasswordError';
  }
}

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Encryption needs a secure context (HTTPS or localhost).');
  return s;
};

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
}

export async function deriveKey(password: string, salt?: string, iter = KDF_ITERATIONS): Promise<NoteKey> {
  const saltB64 = salt ?? toB64(randomBytes(16));
  const material = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations: iter },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { key, salt: saltB64, iter };
}

export async function encryptText(plain: string, nk: NoteKey): Promise<Envelope> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, nk.key, new TextEncoder().encode(plain));
  return { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: nk.iter, salt: nk.salt, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function decryptText(env: Envelope, nk: NoteKey): Promise<string> {
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) }, nk.key, fromB64(env.ct));
    return new TextDecoder().decode(pt);
  } catch {
    // GCM authentication failure: wrong key (or tampered data).
    throw new WrongPasswordError();
  }
}

const FENCE = /```ultron-encrypted\s*\n([\s\S]*?)\n```/;

export function isLocked(content: string): boolean {
  return /^---\r?\n[\s\S]*?^ultron-encrypted:/m.test(content.slice(0, 500)) && FENCE.test(content);
}

export function parseEnvelope(content: string): Envelope | null {
  const m = FENCE.exec(content);
  if (!m) return null;
  try {
    const env = JSON.parse(m[1]) as Envelope;
    if (env.v !== 1 || !env.ct || !env.iv || !env.salt) return null;
    return env;
  } catch {
    return null;
  }
}

/** Wrap an envelope as a Markdown note that explains itself to other tools. */
export function serializeLocked(env: Envelope): string {
  return [
    '---',
    'ultron-encrypted: v1',
    '---',
    '# 🔒 Locked note',
    '',
    'This note is encrypted. Open it in Ultron and enter its password to read it.',
    'Editing this file elsewhere will make it impossible to unlock.',
    '',
    '```ultron-encrypted',
    JSON.stringify(env),
    '```',
    '',
  ].join('\n');
}

/** Encrypt a note's full Markdown (frontmatter included) into a locked file. */
export async function lockContent(plain: string, nk: NoteKey): Promise<string> {
  return serializeLocked(await encryptText(plain, nk));
}

/** Decrypt a locked file. Throws WrongPasswordError if the key doesn't match. */
export async function unlockContent(content: string, nk: NoteKey): Promise<string> {
  const env = parseEnvelope(content);
  if (!env) throw new Error('This locked note is damaged and cannot be decrypted.');
  return decryptText(env, nk);
}

/** Derive the key for an existing locked file from a password (uses the file's salt). */
export async function keyForContent(content: string, password: string): Promise<NoteKey> {
  const env = parseEnvelope(content);
  if (!env) throw new Error('This locked note is damaged and cannot be decrypted.');
  const nk = await deriveKey(password, env.salt, env.iter);
  await decryptText(env, nk); // verify
  return nk;
}
