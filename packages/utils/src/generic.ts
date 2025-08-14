import type { AuthenticationCreds } from "@wha.ts/types";
import { Curve, randomBytes } from "@wha.ts/utils";
import type { KeyPair } from "./types";

export const generateRegistrationId = (): number => {
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
		accountSettings: {
			unarchiveChats: false,
		},
		accountSyncCounter: 0,
		advSecretKey: randomBytes(32),
		firstUnuploadedPreKeyId: 1,
		nextPreKeyId: 1,
		noiseKey: Curve.generateKeyPair(),
		pairingCode: undefined,
		pairingEphemeralKeyPair: Curve.generateKeyPair(),
		processedMessages: [],
		registered: false,
		registrationId: generateRegistrationId(),
		routingInfo: undefined,
		signedIdentityKey: identityKey,
		signedPreKey: Curve.signedKeyPair(identityKey, 1),
	};
};

export const generateMdTagPrefix = () => {
	const bytes = randomBytes(4);

	const view = new DataView(bytes.buffer);
	const part1 = view.getUint16(0, false);
	const part2 = view.getUint16(2, false);

	return `${part1}.${part2}`;
};

export const generatePreKeys = (
	startId: number,
	count: number,
): { [id: number]: KeyPair } => {
	const keys: { [id: number]: KeyPair } = {};
	for (let i = 0; i < count; i++) {
		const id = startId + i;
		keys[id] = Curve.generateKeyPair();
	}
	return keys;
};
