import { generateKeyPair, sharedKey, sign, verify } from "curve25519-js";
import { concatBytes } from "./bytes-utils";
import { randomBytes } from "./crypto";
import type { KeyPair } from "./types";

export const KEY_BUNDLE_TYPE = new Uint8Array([5]);

const STRIP_PREFIX = (publicKey: Uint8Array): Uint8Array => {
	if (!(publicKey instanceof Uint8Array)) {
		throw new Error(`Invalid public key type: ${typeof publicKey}`);
	}
	if (
		publicKey === undefined ||
		((publicKey.byteLength !== 33 || publicKey[0] !== 5) &&
			publicKey.byteLength !== 32)
	) {
		throw new Error("Invalid public key");
	}
	if (publicKey.byteLength === 33) {
		return publicKey.slice(1);
	}

	return publicKey;
};

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
		const shared = sharedKey(privateKey, STRIP_PREFIX(publicKey));
		return shared;
	},
	sign: (privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array => {
		return sign(privateKey, publicKey, undefined);
	},
	verify: (
		publicKey: Uint8Array,
		message: Uint8Array,
		signature: Uint8Array,
	): boolean => {
		try {
			return verify(publicKey, message, signature);
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
			concatBytes(KEY_BUNDLE_TYPE, preKey.publicKey),
		);

		return { keyPair: preKey, signature, keyId };
	},
};
