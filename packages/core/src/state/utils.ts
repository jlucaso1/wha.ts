import { randomBytes } from "@wha.ts/utils/src/crypto";
import { Curve } from "@wha.ts/utils/src/curve";
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
		signedPreKey: Curve.signedKeyPair(identityKey, 1),
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

export const generateMdTagPrefix = () => {
	const bytes = randomBytes(4);

	const view = new DataView(bytes.buffer);
	const part1 = view.getUint16(0, false);
	const part2 = view.getUint16(2, false);

	return `${part1}.${part2}`;
};
