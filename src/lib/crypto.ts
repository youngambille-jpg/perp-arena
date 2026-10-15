// AES-256-GCM encryption for Perpl API key material at rest.
// The master key comes from KEY_ENCRYPTION_KEY (32 random bytes, hex).
// Stored value format: "<iv hex>:<auth tag hex>:<ciphertext hex>".

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KEY_ENCRYPTION_KEY } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, KEY_ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decrypt(stored: string): string {
  const [ivHex, tagHex, ciphertextHex] = stored.split(':');
  if (!ivHex || !tagHex || !ciphertextHex) {
    throw new Error('Encrypted value is malformed');
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    KEY_ENCRYPTION_KEY,
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
