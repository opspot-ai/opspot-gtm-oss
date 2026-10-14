import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export type SecretEnvelope = { reference: string; keyId: string; ciphertext: string };

function keyBytes(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new Error("secret key must be exactly 32 bytes");
  return Buffer.from(key);
}

function decode(value: string): Buffer { return Buffer.from(value, "base64url"); }

function parts(ciphertext: string): [string, string, string] {
  const [version, iv, encrypted, tag, ...extra] = ciphertext.split(".");
  if (version !== VERSION || !iv || !encrypted || !tag || extra.length) throw new Error("invalid secret envelope");
  return [iv, encrypted, tag];
}

export function createSecretReference(): string { return `secret_${randomUUID().replaceAll("-", "")}`; }

export function encryptSecret(key: Uint8Array, keyId: string, plaintext: string, reference = createSecretReference()): SecretEnvelope {
  if (!keyId) throw new Error("secret key id is required");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyBytes(key), iv);
  cipher.setAAD(Buffer.from(`${keyId}:${reference}`));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const ciphertext = [VERSION, iv.toString("base64url"), encrypted.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  return { reference, keyId, ciphertext };
}

export function decryptSecret(key: Uint8Array, envelope: SecretEnvelope): string {
  const [iv, encrypted, tag] = parts(envelope.ciphertext);
  try {
    const decipher = createDecipheriv(ALGORITHM, keyBytes(key), decode(iv));
    decipher.setAAD(Buffer.from(`${envelope.keyId}:${envelope.reference}`));
    decipher.setAuthTag(decode(tag));
    return Buffer.concat([decipher.update(decode(encrypted)), decipher.final()]).toString("utf8");
  } catch { throw new Error("secret decryption failed"); }
}

/** Safe for receipts, logs, API responses, and client state; never returns ciphertext or plaintext. */
export function redactSecret(envelope: Pick<SecretEnvelope, "reference" | "keyId">): { reference: string; keyId: string; redacted: true } {
  return { reference: envelope.reference, keyId: envelope.keyId, redacted: true };
}
