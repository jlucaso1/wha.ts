import { cbc, ctr, gcm } from "@noble/ciphers/webcrypto";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf";
import { hmac as nobleHmac } from "@noble/hashes/hmac";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2";
import type { KeyPair } from "../state/interface";
import { concatBytes } from "../utils/bytes-utils";
import { KEY_BUNDLE_TYPE } from "../defaults";
import { sign, verify, generateKeyPair, sharedKey } from "curve25519-js";

export const Curve = {
  generateKeyPair: (): KeyPair => {
    const { private: privateKey, public: publicKey } = generateKeyPair(
      randomBytes(32)
    );

    return {
      private: privateKey,
      public: publicKey,
    };
  },
  sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array) => {
    const shared = sharedKey(privateKey, publicKey);
    return shared;
  },
  sign: (privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array => {
    return sign(privateKey, publicKey, undefined);
  },
  verify: (pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
    try {
      return verify(pubKey, message, signature);
    } catch {
      return false;
    }
  },
};

export const signedKeyPair = (identityKeyPair: KeyPair, keyId: number) => {
  const preKey = Curve.generateKeyPair();

  const signature = Curve.sign(
    identityKeyPair.private,
    concatBytes(KEY_BUNDLE_TYPE, preKey.public)
  );

  return { keyPair: preKey, signature, keyId };
};

export async function aesEncryptGCM(
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  additionalData: Uint8Array
): Promise<Uint8Array> {
  const cipher = gcm(key, iv, additionalData);
  const ciphertext = await cipher.encrypt(plaintext);
  return ciphertext;
}

export async function aesDecryptGCM(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  additionalData: Uint8Array
): Promise<Uint8Array> {
  const cipher = gcm(key, iv, additionalData);
  const plaintext = await cipher.decrypt(ciphertext);
  return plaintext;
}

export async function aesEncryptCTR(
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cipher = ctr(key, iv);
  const ciphertext = await cipher.encrypt(plaintext);
  return ciphertext;
}

export async function aesDecryptCTR(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cipher = ctr(key, iv);
  const plaintext = await cipher.decrypt(ciphertext);
  return plaintext;
}

export async function aesDecrypt(buffer: Uint8Array, key: Uint8Array) {
  return aesDecryptWithIV(
    buffer.slice(16, buffer.length),
    key,
    buffer.slice(0, 16)
  );
}

export async function aesDecryptWithIV(
  buffer: Uint8Array,
  key: Uint8Array,
  IV: Uint8Array
): Promise<Uint8Array> {
  const cipher = cbc(key, IV);
  const plaintext = await cipher.decrypt(buffer);
  return plaintext;
}

export async function aesEncrypt(
  buffer: Uint8Array,
  key: Uint8Array
): Promise<Uint8Array> {
  const iv = randomBytes(16);
  const cipher = cbc(key, iv);
  const ciphertext = await cipher.encrypt(buffer);
  const result = new Uint8Array(iv.length + ciphertext.length);
  result.set(iv, 0);
  result.set(ciphertext, iv.length);
  return result;
}

export function hmacSign(buffer: Uint8Array, key: Uint8Array): Uint8Array {
  const mac = nobleHmac(nobleSha256, key, buffer);
  return mac;
}

export function sha256(buffer: Uint8Array) {
  const hash = nobleSha256(buffer);
  return hash;
}

export function hkdf(
  buffer: Uint8Array,
  expandedLength: number,
  info: { salt?: Uint8Array; info?: string }
): Uint8Array {
  return nobleHkdf(nobleSha256, buffer, info.salt, info.info, expandedLength);
}

export function randomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}
