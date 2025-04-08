import {
	cbc,
	ctr,
	gcm,
	randomBytes as nobleRandomBytes,
} from "@noble/ciphers/webcrypto";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf";
import { hmac as nobleHmac } from "@noble/hashes/hmac";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2";
import type { KeyPair } from "../state/interface";
import { md5External } from "../../external/md5";

export const Curve = {
	generateKeyPair: (): KeyPair => {
		const priv = x25519.utils.randomPrivateKey();
		const pub = x25519.getPublicKey(priv);

		return {
			private: priv,
			public: pub,
		};
	},
	sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array) => {
		const shared = x25519.getSharedSecret(privateKey, publicKey);
		return shared;
	},
	sign: (privateKey: Uint8Array, buf: Uint8Array) => {
		const sig = ed25519.sign(buf, privateKey);
		return sig;
	},
	verify: (pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
		try {
			return ed25519.verify(signature, message, pubKey);
		} catch {
			return false;
		}
	},
};

export const signedKeyPair = (identityKeyPair: KeyPair, keyId: number) => {
	const preKey = Curve.generateKeyPair();

	const signature = Curve.sign(identityKeyPair.private, preKey.public);

	return { keyPair: preKey, signature, keyId };
};

export async function aesEncryptGCM(
	plaintext: Uint8Array,
	key: Uint8Array,
	iv: Uint8Array,
	additionalData: Uint8Array,
): Promise<Uint8Array> {
	const cipher = gcm(key, iv, additionalData);
	const ciphertext = await cipher.encrypt(plaintext);
	return ciphertext;
}

export async function aesDecryptGCM(
	ciphertext: Uint8Array,
	key: Uint8Array,
	iv: Uint8Array,
	additionalData: Uint8Array,
): Promise<Uint8Array> {
	const cipher = gcm(key, iv, additionalData);
	const plaintext = await cipher.decrypt(ciphertext);
	return plaintext;
}

export async function aesEncryptCTR(
	plaintext: Uint8Array,
	key: Uint8Array,
	iv: Uint8Array,
): Promise<Uint8Array> {
	const cipher = ctr(key, iv);
	const ciphertext = await cipher.encrypt(plaintext);
	return ciphertext;
}

export async function aesDecryptCTR(
	ciphertext: Uint8Array,
	key: Uint8Array,
	iv: Uint8Array,
): Promise<Uint8Array> {
	const cipher = ctr(key, iv);
	const plaintext = await cipher.decrypt(ciphertext);
	return plaintext;
}

export async function aesDecrypt(buffer: Uint8Array, key: Uint8Array) {
	return aesDecryptWithIV(
		buffer.slice(16, buffer.length),
		key,
		buffer.slice(0, 16),
	);
}

export async function aesDecryptWithIV(
	buffer: Uint8Array,
	key: Uint8Array,
	IV: Uint8Array,
): Promise<Uint8Array> {
	const cipher = cbc(key, IV);
	const plaintext = await cipher.decrypt(buffer);
	return plaintext;
}

export async function aesEncrypt(
	buffer: Uint8Array,
	key: Uint8Array,
): Promise<Uint8Array> {
	const iv = nobleRandomBytes(16);
	const cipher = cbc(key, iv);
	const ciphertext = await cipher.encrypt(buffer);
	const result = new Uint8Array(iv.length + ciphertext.length);
	result.set(iv, 0);
	result.set(ciphertext, iv.length);
	return result;
}

export function hmacSign(
	buffer: Uint8Array,
	key: Uint8Array,
): Uint8Array {
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
	info: { salt?: Uint8Array; info?: string },
): Uint8Array {
	return nobleHkdf(nobleSha256, buffer, info.salt, info.info, expandedLength);
}

export function randomBytes(size: number): Uint8Array {
	return nobleRandomBytes(size);
}

export function md5(buffer: Uint8Array): Uint8Array {
	const hash = md5External(buffer);
	return hash;
}
