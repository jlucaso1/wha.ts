import { generateKeyPair, sharedKey, sign, verify } from "curve25519-js";
import { concatBytes } from "./bytes-utils";
import { randomBytes } from "./crypto";
import type { KeyPair } from "./types";

export const Curve = {
	generateKeyPair: (): KeyPair => {
		const { private: privateKey, public: publicKey } = generateKeyPair(
			randomBytes(32),
		);

		return {
			privateKey,
			publicKey,
		};
	},
	sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array => {
		const shared = sharedKey(privateKey, publicKey);
		return shared;
	},
	sign: (privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array => {
		return sign(privateKey, publicKey, undefined);
	},
	verify: (
		pubKey: Uint8Array,
		message: Uint8Array,
		signature: Uint8Array,
	): boolean => {
		try {
			return verify(pubKey, message, signature);
		} catch {
			return false;
		}
	},

	signedKeyPair: (
		identityKeyPair: KeyPair,
		keyId: number,
	): { keyPair: KeyPair; signature: Uint8Array; keyId: number } => {
		const preKey = Curve.generateKeyPair();

		const signature = Curve.sign(
			identityKeyPair.privateKey,
			concatBytes(new Uint8Array([5]), preKey.publicKey),
		);

		return { keyPair: preKey, signature, keyId };
	},
};
