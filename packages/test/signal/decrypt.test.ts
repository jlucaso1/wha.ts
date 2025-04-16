import { expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { jidDecode } from "@wha.ts/binary/src/jid-utils";
import { SignalProtocolStoreAdapter } from "@wha.ts/core/src/signal/signal-store";
import { GenericAuthState } from "@wha.ts/core/src/state/providers/generic-auth-state";
import { MessageSchema } from "@wha.ts/proto";
import { ProtocolAddress, SessionCipher } from "@wha.ts/signal/src";
import {
	base64ToBytes,
	hexToBytes,
	unpadRandomMax16,
} from "@wha.ts/utils/src/bytes-utils";

const mockedSession = {
	prekeys: {
		"1": {
			publicKey: base64ToBytes("BkafFXIgf7aQLe0Yq2tWGazJon8p/YVhTg0b3CBQUiQ="),
			privateKey: base64ToBytes("cDM+1py89DdQZQ5v2mXzzDAZng1EJFCX8G0e6FgmsFM="),
		},
	},
	creds: {
		signedIdentityKey: {
			privateKey: base64ToBytes("WD5ebyuM8f3z/+N1mVctxUulH8YHmjQVEvrBBNtN32Q="),
			publicKey: base64ToBytes("ycV49bs+W0e4TFWx47eWZ1rslyFDj3lghBdswqQwg0k="),
		},
		signedPreKey: {
			keyPair: {
				privateKey: base64ToBytes(
					"MOdStlW3mnNXm6oZEAPNxjTrsiL872urL69RlpIEb3A=",
				),
				publicKey: base64ToBytes(
					"rigEUq6mofGNPBTF3h3N+kfU4dnrd0A0WNMTvT55bTU=",
				),
			},
			signature: base64ToBytes(
				"HdIBCtzfzUIKNWjJdOLfFGoeweBX8aJJLDkofTqWnluR0N+F3cefDSet0VadvMPBB3d2wUcBM3P25gFjZLgdBw==",
			),
			keyId: 1,
		},
	},
};

const pkgmsg = {
	jid: "999999999999@s.whatsapp.net",
	type: "pkmsg",
	ciphertext: hexToBytes(
		"330801122105daaa2712acb99e072d3f044f04cfc12440f6db79a8a4522c7a05e339f78362351a21058bac306f0c1618b8779899f40976433a9b682dcb5800e73493c2505efa174059228302330a2105e05117e08f819ee333cc06cf1c545124a3181e35f22907a59513683c8a3a1f451006180022d001d1c7e6b3f590ef78aae238662165bb4717e66b4c6b836b937c572c01cf45394fee4985a6e831d6688fcd2cbde4bef9ec8c120eb749544c2734d34b93ac8129814dfedde26557380565687696a8ead5e11b18dab3bae4ffc0a91430d9ec0ff0b8951566873993849c1515f1ba3d59f244dc043bdcbd16a88ebc50241e94cae68fd2f054ff3f3115153ecdd857cac822a6102a1f452ad815984472c2a60dcb01b52362d45b841a6a282c7ba69a6bd946db8a5ab22042dbc1466edf0dae0f2bcb37e45cb4006186f3df4c6b84d5852ba9f3cb4756dc29dc92802896eaeca2023001",
	),
	plaintext: hexToBytes(
		"fa0180010a1b35353939383437323636363240732e77686174736170702e6e65741261323a0a07426f6d2064696150008a0129ea0116676c6f62616c5f7365617263685f6e65775f63686174f201087768617473617070f801c0d524e801009a02221a20f927a5cdb4875c3da4db91cdcd5d861e8673ca7b27be16d02855d53d024769dc9a02380a120a0a5c4d235b440c44fa50631082defbbf0610021a20f927a5cdb4875c3da4db91cdcd5d861e8673ca7b27be16d02855d53d024769dc0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
	),
};

test("decrypts a message", async () => {
	const authStateProvider = await GenericAuthState.init();

	authStateProvider.keys.set({
		"pre-key": mockedSession.prekeys,
	});

	Object.assign(authStateProvider.creds, mockedSession.creds);

	const signalStore = new SignalProtocolStoreAdapter(authStateProvider);
	const decodedJid = jidDecode(pkgmsg.jid);
	if (!decodedJid || !decodedJid.user) {
		throw new Error("Invalid JID");
	}
	const senderAddress = new ProtocolAddress(
		decodedJid.user,
		decodedJid.device ?? 0,
	);

	const cipher = new SessionCipher(
		// @ts-ignore
		signalStore,
		senderAddress,
	);

	const plaintextBuffer = await cipher.decryptPreKeyWhisperMessage(
		pkgmsg.ciphertext,
	);

	const message = fromBinary(MessageSchema, unpadRandomMax16(plaintextBuffer));

	expect(message).toBeDefined();
	expect(message.deviceSentMessage?.message?.extendedTextMessage?.text).toBe(
		"Bom dia",
	);
});
