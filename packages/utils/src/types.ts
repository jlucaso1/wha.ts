export type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };

export type SignedKeyPair = {
	keyPair: KeyPair;
	signature: Uint8Array;
	keyId: number;
};

export type ProtocolAddress = {
	name: string;
	deviceId: number;
};

export type SignalIdentity = {
	identifier: ProtocolAddress;
	identifierKey: Uint8Array;
};
