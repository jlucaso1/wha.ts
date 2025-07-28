import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { jidDecode } from "@wha.ts/binary";
import { SignalProtocolStoreAdapter } from "@wha.ts/core";
import { PreKeySignalMessageSchema } from "@wha.ts/proto";
import { ProtocolAddress, SessionCipher } from "@wha.ts/signal";
import { GenericAuthState, InMemorySimpleKeyValueStore } from "@wha.ts/storage";
import { Curve, concatBytes } from "@wha.ts/utils";

function encodeTupleByte(number1: number, number2: number): number {
	return (number1 << 4) | number2;
}

const SIGNAL_MESSAGE_VERSION = 3;

const incomingPkMsgWithPreKeyId0 = {
	jid: "1234567890@s.whatsapp.net",
	preKeySignalMessage: {
		preKeyId: 0,
		signedPreKeyId: 1,
		baseKey: Curve.generateKeyPair().publicKey,
		identityKey: Curve.generateKeyPair().publicKey,
		message: new Uint8Array([
			0x08, 0x01, 0x12, 0x05, 0x0a, 0x03, 0x61, 0x62, 0x63,
		]),
		registrationId: 1234,
	},
};

test("should throw when trying to decrypt a pkmsg with a non-existent preKeyId", async () => {
	const storage = new InMemorySimpleKeyValueStore();
	const authStateProvider = await GenericAuthState.init(storage);

	await authStateProvider.keys.set({ "pre-key": { "0": null } });

	const signalStore = new SignalProtocolStoreAdapter(
		authStateProvider,
		console,
	);

	const decodedJid = jidDecode(incomingPkMsgWithPreKeyId0.jid);
	if (!decodedJid || !decodedJid.user) {
		throw new Error("Invalid JID for test setup");
	}
	const senderAddress = new ProtocolAddress(
		decodedJid.user,
		decodedJid.device ?? 0,
	);

	const cipher = new SessionCipher(signalStore, senderAddress);

	const preKeyProto = create(
		PreKeySignalMessageSchema,
		incomingPkMsgWithPreKeyId0.preKeySignalMessage,
	);
	const preKeyBytes = toBinary(PreKeySignalMessageSchema, preKeyProto);

	const correctVersionByte = encodeTupleByte(
		SIGNAL_MESSAGE_VERSION,
		SIGNAL_MESSAGE_VERSION,
	);
	const fullMessageBytes = concatBytes(
		new Uint8Array([correctVersionByte]),
		preKeyBytes,
	);

	await expect(
		cipher.decryptPreKeyWhisperMessage(fullMessageBytes),
	).rejects.toThrow(
		"Session establishment failed for pre-key message, likely due to missing pre-key 0",
	);

	console.log(
		"\n✅ Test successfully reproduced the 'Invalid PreKey ID: 0' error.",
	);
});
