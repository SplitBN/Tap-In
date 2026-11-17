// AES-GCM for credentials at rest. Key = wrangler secret AI_ENC_KEY (base64 of 32 random bytes).
// Format: base64(iv[12] || ciphertext+tag). Never log inputs or outputs.
import { HttpError } from '../http';

const keys = new Map<string, Promise<CryptoKey>>();
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function key(secret: string | undefined) {
  if (!secret) throw new HttpError(503, 'AI is not configured on the server');
  let k = keys.get(secret);
  if (!k) {
    const raw = unb64(secret.trim());
    if (raw.length !== 32) throw new HttpError(503, 'AI is not configured on the server');
    k = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keys.set(secret, k);
  }
  return k;
}

export async function encrypt(secret: string | undefined, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), new TextEncoder().encode(plain)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64(out);
}

export async function decrypt(secret: string | undefined, sealed: string) {
  const buf = unb64(sealed);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, await key(secret), buf.subarray(12));
  return new TextDecoder().decode(pt);
}

export { b64, unb64 };
