/**
 * Locked notes: end-to-end encryption of individual notes in the browser.
 *
 * - AES-256-GCM with a fresh random 96-bit IV for every save.
 * - The key is derived from the user's password with PBKDF2-SHA256 (600,000
 *   iterations) and a random 128-bit salt per note.
 * - Only the envelope is ever sent to the server. The password and plaintext
 *   stay in this browser tab's memory.
 * - Uses the browser's Web Crypto when available. On plain-http pages (e.g. a
 *   phone on the home Wi-Fi), where browsers disable Web Crypto, the same
 *   algorithms run in JavaScript (@noble), producing identical envelopes.
 *
 * File format (still a valid Markdown note, so other tools show a placeholder):
 *
 *   ---
 *   octavo-encrypted: v1
 *   ---
 *   # 🔒 Locked note
 *   …explanation…
 *   ```octavo-encrypted
 *   {"v":1,"alg":"AES-256-GCM","kdf":"PBKDF2-SHA256","iter":600000,"salt":"…","iv":"…","ct":"…"}
 *   ```
 */

import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const KDF_ITERATIONS = 600_000;

let forceFallback = false;
/** Tests use this to exercise the pure-JS path. */
export function _setForceFallback(v: boolean) {
  forceFallback = v;
}
const webCrypto = (): SubtleCrypto | null => (forceFallback ? null : globalThis.crypto?.subtle ?? null);

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
  /** Raw 256-bit AES key. */
  raw: Uint8Array<ArrayBuffer>;
  /** Imported Web Crypto key, when Web Crypto is available. */
  ck?: CryptoKey;
  salt: string;
  iter: number;
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password');
    this.name = 'WrongPasswordError';
  }
}


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
  const pw = new TextEncoder().encode(password);
  const subtle = webCrypto();
  let raw: Uint8Array<ArrayBuffer>;
  if (subtle) {
    const material = await subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations: iter }, material, 256);
    raw = new Uint8Array(bits);
  } else {
    const out = await pbkdf2Async(sha256, pw, fromB64(saltB64), { c: iter, dkLen: 32, asyncTick: 20 });
    raw = new Uint8Array(new ArrayBuffer(32));
    raw.set(out);
  }
  const ck = subtle ? await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']) : undefined;
  return { raw, ck, salt: saltB64, iter };
}

export async function encryptText(plain: string, nk: NoteKey): Promise<Envelope> {
  const iv = randomBytes(12);
  const data = new TextEncoder().encode(plain);
  const subtle = webCrypto();
  const ct = subtle && nk.ck ? new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, nk.ck, data)) : gcm(nk.raw, iv).encrypt(data);
  return { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: nk.iter, salt: nk.salt, iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptText(env: Envelope, nk: NoteKey): Promise<string> {
  try {
    const subtle = webCrypto();
    const iv = fromB64(env.iv);
    const ct = fromB64(env.ct);
    const pt = subtle && nk.ck ? new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, nk.ck, ct)) : gcm(nk.raw, iv).decrypt(ct);
    return new TextDecoder().decode(pt);
  } catch {
    // GCM authentication failure: wrong key (or tampered data).
    throw new WrongPasswordError();
  }
}

// "ultron-encrypted" is the marker from before the rename to Octavo; still readable.
const FENCE = /```(?:octavo|ultron)-encrypted\s*\n([\s\S]*?)\n```/;

export function isLocked(content: string): boolean {
  return /^---\r?\n[\s\S]*?^(?:octavo|ultron)-encrypted:/m.test(content.slice(0, 500)) && FENCE.test(content);
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
    'octavo-encrypted: v1',
    '---',
    '# 🔒 Locked note',
    '',
    'This note is encrypted. Open it in Octavo and enter its password to read it.',
    'Editing this file elsewhere will make it impossible to unlock.',
    '',
    '```octavo-encrypted',
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
