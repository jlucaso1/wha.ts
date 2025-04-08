import { test, expect } from "bun:test";
import { Curve, aesEncryptGCM, aesDecryptGCM, randomBytes } from "../../src/signal/crypto";

test("Curve key generation", () => {
  const keyPair = Curve.generateKeyPair();
  expect(keyPair.public).toBeInstanceOf(Uint8Array);
  expect(keyPair.private).toBeInstanceOf(Uint8Array);
  expect(keyPair.public.length).toBe(32);
  expect(keyPair.private.length).toBe(32);
});

test("AES-GCM encryption/decryption", async () => {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = randomBytes(100);
  const aad = randomBytes(20);

  const ciphertext = await aesEncryptGCM(plaintext, key, iv, aad);
  expect(ciphertext).not.toEqual(plaintext);

  const decrypted = await aesDecryptGCM(ciphertext, key, iv, aad);
  expect(decrypted).toEqual(plaintext);
});
