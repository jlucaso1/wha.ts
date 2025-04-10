import { Curve, randomBytes, signedKeyPair } from "../signal/crypto";
import { base64ToBytes, bytesToBase64 } from "../utils/bytes-utils";
import type { AuthenticationCreds } from "./interface";

const generateRegistrationId = (): number => {
	const random = randomBytes(2);

	const numbers = Uint16Array.from(random);

	const number = numbers[0];

	if (!number) {
		throw new Error("Failed to generate registration ID");
	}

	return number & 16383;
};

export const initAuthCreds = (): AuthenticationCreds => {
	const identityKey = Curve.generateKeyPair();

	return {
		noiseKey: Curve.generateKeyPair(),
		pairingEphemeralKeyPair: Curve.generateKeyPair(),
		signedIdentityKey: identityKey,
		signedPreKey: signedKeyPair(identityKey, 1),
		registrationId: generateRegistrationId(),
		advSecretKey: randomBytes(32),
		nextPreKeyId: 1,
		firstUnuploadedPreKeyId: 1,
		accountSyncCounter: 0,
		accountSettings: {
			unarchiveChats: false,
		},
		registered: false,
		pairingCode: undefined,
		routingInfo: undefined,
	};
};

export const BufferJSON = {
	replacer: (_k: string, value: any) => {
		if (value instanceof Uint8Array || value?.type === "Buffer") {
			return {
				type: "Buffer",
				data: bytesToBase64(value?.data || value),
			};
		}

		return value;
	},

	reviver: (_k: string, value: any) => {
		if (
			typeof value === "object" &&
			!!value &&
			(value.buffer === true || value.type === "Buffer")
		) {
			const val = value.data || value.value;
			return typeof val === "string"
				? base64ToBytes(val)
				: new Uint8Array(val || []);
		}

		return value;
	},
};
