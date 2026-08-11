/**
 * Client-side E2E encryption for SomLuul chat (Web Crypto API).
 * Server only stores ciphertext. Key is derived from sorted participant IDs.
 */

async function deriveKey(roomId: string, userA: string, userB: string): Promise<CryptoKey> {
  const sorted = [userA, userB].sort().join('|');
  const material = `somluul-e2e-v1|${roomId}|${sorted}`;
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(material),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode('somluul-chat-salt-v1'),
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBuf(b64: string): ArrayBuffer {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

export async function encryptMessage(
  plaintext: string,
  roomId: string,
  userA: string,
  userB: string
): Promise<string> {
  if (!plaintext) return plaintext;
  try {
    const key = await deriveKey(roomId, userA, userB);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    return `e2e:${bufToB64(iv.buffer)}:${bufToB64(ct)}`;
  } catch {
    return plaintext;
  }
}

export async function decryptMessage(
  payload: string,
  roomId: string,
  userA: string,
  userB: string
): Promise<string> {
  if (!payload || !payload.startsWith('e2e:')) return payload;
  try {
    // Format: e2e:<ivB64>:<ciphertextB64>
    const rest = payload.slice(4);
    const colon = rest.indexOf(':');
    if (colon < 1) return payload;
    const ivB64 = rest.slice(0, colon);
    const ctB64 = rest.slice(colon + 1);
    if (!ivB64 || !ctB64) return payload;
    const iv = new Uint8Array(b64ToBuf(ivB64));
    const ct = b64ToBuf(ctB64);
    const key = await deriveKey(roomId, userA, userB);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return '[Encrypted message – cannot decrypt]';
  }
}

export function isEncrypted(content: string): boolean {
  return typeof content === 'string' && content.startsWith('e2e:');
}
