import { expect, mock, spyOn, test } from "bun:test";
import { createWAClient } from "@wha.ts/core/src/client";
import type { ConnectionManager } from "@wha.ts/core/src/core/connection";
import type {
	AuthenticationCreds,
	ISignalProtocolStore,
} from "@wha.ts/core/src/state/interface";
import { ProtocolAddress } from "@wha.ts/signal/src/protocol_address";
import { SessionCipher } from "@wha.ts/signal/src/session_cipher";

test("sendTextMessage fans out to all recipient devices", async () => {
	const mockSignalStore = {
		getAllSessionRecordsForUser: mock().mockResolvedValue([
			{
				address: new ProtocolAddress("12345", 0),
				record: {},
			},
			{
				address: new ProtocolAddress("12345", 1),
				record: {},
			},
		]),
	};

	const encryptMock = mock()
		.mockResolvedValueOnce({
			type: 2,
			body: new Uint8Array([1, 2, 3]),
			registrationId: 1,
		})
		.mockResolvedValueOnce({
			type: 2,
			body: new Uint8Array([4, 5, 6]),
			registrationId: 2,
		});

	const encryptSpy = spyOn(
		SessionCipher.prototype,
		"encrypt",
	).mockImplementation(encryptMock);

	const sendNodeMock = mock().mockResolvedValue(undefined);

	const client = createWAClient({
		auth: {
			creds: {} as AuthenticationCreds,
			keys: {} as ISignalProtocolStore,
			saveCreds: async () => {},
		},
		logger: console,
		connectionManager: {
			sendNode: sendNodeMock,
			addEventListener: () => {},
			connect: mock().mockResolvedValue(undefined),
			close: mock().mockResolvedValue(undefined),
		} as unknown as ConnectionManager,
	});
	Object.assign(client, {
		signalStore: mockSignalStore,
	});

	const msgId = await client.sendTextMessage("12345@s.whatsapp.net", "hello");

	expect(typeof msgId).toBe("string");
	expect(msgId.length).toBeGreaterThan(0);
	expect(mockSignalStore.getAllSessionRecordsForUser).toHaveBeenCalledWith(
		"12345@s.whatsapp.net",
	);
	expect(encryptMock).toHaveBeenCalledTimes(2);
	expect(sendNodeMock).toHaveBeenCalledTimes(2);

	const sentNodes = sendNodeMock.mock.calls.map((call) => call[0]);
	expect(sentNodes[0].attrs.to).toBe("12345@s.whatsapp.net");
	expect(sentNodes[1].attrs.to).toBe("12345@s.whatsapp.net");
	expect(sentNodes[0].attrs.id).toBe(msgId);
	expect(sentNodes[1].attrs.id).toBe(msgId);

	encryptSpy.mockRestore();
});
