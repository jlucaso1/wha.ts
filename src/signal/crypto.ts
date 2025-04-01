import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  diffieHellman,
  createPublicKey,
  createPrivateKey,
  randomBytes as cryptoRandomBytes,
  type CipherGCM,
  type DecipherGCM,
  hkdf,
} from "crypto";
import { promisify } from "util";
import { Buffer } from "node:buffer";
import type { KeyPair, SignedKeyPair } from "../state/interface";
import { x25519 } from "@noble/curves/ed25519";
import { ed25519 } from "@noble/curves/ed25519";

const GCM_TAG_LENGTH = 16;
const AES_KEY_SIZE = 32;
const AES_IV_SIZE = 12;

const hkdfPromise = promisify(hkdf);

export function computeX25519SharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Uint8Array {
  const privKeyObj = createPrivateKey({
    key: Buffer.from(privateKey),
    format: "der",
    type: "pkcs8",
  });
  const pubKeyObj = createPublicKey({
    key: Buffer.from(publicKey),
    format: "der",
    type: "spki",
  });
  return diffieHellman({ privateKey: privKeyObj, publicKey: pubKeyObj });
}

export function sha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return createHmac("sha256", key).update(data).digest();
}

export async function hkdfSha256(
  inputMaterial: Uint8Array,
  outputLength: number,
  {
    salt = Buffer.alloc(0),
    info = Buffer.alloc(0),
  }: { salt?: Uint8Array; info?: Uint8Array }
): Promise<Uint8Array> {
  try {
    const derivedKey = await hkdfPromise(
      "sha256",
      inputMaterial,
      salt,
      info,
      outputLength
    );
    return Buffer.from(derivedKey);
  } catch (e: any) {
    console.warn(
      "Native HKDF failed or unavailable, using slower JS fallback:",
      e.message
    );
    return jsHkdfSha256(inputMaterial, outputLength, { salt, info });
  }
}

function jsHkdfSha256(
  ikm: Uint8Array,
  length: number,
  {
    salt = Buffer.alloc(0),
    info = Buffer.alloc(0),
  }: { salt?: Uint8Array; info?: Uint8Array }
): Buffer {
  const hashLen = 32;
  const prk = hmacSha256(salt, ikm);
  const N = Math.ceil(length / hashLen);
  if (N > 255) {
    throw new Error("Output length too large for HKDF");
  }

  let T = Buffer.alloc(0);
  let T_prev = Buffer.alloc(0);
  for (let i = 1; i <= N; i++) {
    const input = Buffer.concat([T_prev, info, Buffer.from([i])]);
    T_prev = Buffer.from(hmacSha256(prk, input));
    T = Buffer.concat([T, T_prev]);
  }
  return Buffer.from(T.subarray(0, length));
}

export function aesGcmEncrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  additionalData?: Uint8Array
): Uint8Array {
  if (key.length !== AES_KEY_SIZE)
    throw new Error(`Invalid AES key size: ${key.length}`);
  if (iv.length !== AES_IV_SIZE)
    throw new Error(`Invalid IV size for GCM: ${iv.length}`);

  const cipher: CipherGCM = createCipheriv("aes-256-gcm", key, iv);
  if (additionalData) {
    cipher.setAAD(additionalData);
  }
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== GCM_TAG_LENGTH)
    throw new Error(`Invalid GCM Auth Tag length: ${authTag.length}`);
  return Buffer.concat([encrypted, authTag]);
}

export function aesGcmDecrypt(
  ciphertextWithTag: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  additionalData?: Uint8Array
): Uint8Array {
  if (key.length !== AES_KEY_SIZE)
    throw new Error(`Invalid AES key size: ${key.length}`);
  if (iv.length !== AES_IV_SIZE)
    throw new Error(`Invalid IV size for GCM: ${iv.length}`);
  if (ciphertextWithTag.length < GCM_TAG_LENGTH)
    throw new Error("Ciphertext too short to contain auth tag");

  const ciphertext = Buffer.from(
    ciphertextWithTag.subarray(0, -GCM_TAG_LENGTH)
  );
  const authTag = Buffer.from(ciphertextWithTag.subarray(-GCM_TAG_LENGTH));

  const decipher: DecipherGCM = createDecipheriv("aes-256-gcm", key, iv);
  if (additionalData) {
    decipher.setAAD(additionalData);
  }
  decipher.setAuthTag(authTag);
  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted;
  } catch (err: any) {
    throw new Error(
      `AES-GCM Decryption failed (possibly bad auth tag): ${err.message}`
    );
  }
}

export function generateAesGcmNonce(counter: number): Uint8Array {
  const iv = Buffer.alloc(AES_IV_SIZE);
  iv.writeBigUInt64BE(BigInt(counter), AES_IV_SIZE - 8);
  return iv;
}

export const generateX25519KeyPair = (): KeyPair => {
  const rawPrivateKey = ed25519.utils.randomPrivateKey();

  const rawPublicKey = x25519.getPublicKey(rawPrivateKey);

  return {
    public: rawPublicKey,
    private: rawPrivateKey,
  };
};

export function signEd25519(
  privateKeyBytes: Uint8Array,
  message: Uint8Array
): Uint8Array {
  console.warn("Using stubbed Ed25519 signing!");

  return cryptoRandomBytes(64);
}

export function randomBytes(length: number): Buffer {
  return cryptoRandomBytes(length);
}

export const signedKeyPair = (
  identityKeyPair: KeyPair,
  keyId: number
): SignedKeyPair => {
  const preKey = generateX25519KeyPair();
  const publicKeyWithVersion = Buffer.concat([
    Buffer.from([0x05]),
    preKey.public,
  ]);
  const signature = signEd25519(identityKeyPair.private, publicKeyWithVersion);

  return { keyPair: preKey, signature, keyId };
};
