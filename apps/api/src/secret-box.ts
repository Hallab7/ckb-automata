import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function decodeEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("WEBHOOK_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

export function encryptSecret(
  plaintext: string,
  key: Buffer,
  associatedData: Buffer,
  randomIv: () => Buffer = () => randomBytes(12),
): string {
  const iv = randomIv();
  if (iv.length !== 12) throw new Error("secret IV provider must return 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function decryptSecret(value: string, key: Buffer, associatedData: Buffer): string {
  const [version, ivValue, ciphertextValue, tagValue, extra] = value.split(".");
  if (
    version !== "v1" ||
    ivValue === undefined ||
    ciphertextValue === undefined ||
    ciphertextValue.length === 0 ||
    tagValue === undefined ||
    extra !== undefined
  ) {
    throw new Error("stored encrypted secret is malformed");
  }
  const iv = Buffer.from(ivValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("stored encrypted secret is malformed");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(associatedData);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
