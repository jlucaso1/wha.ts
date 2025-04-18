import { createWAClient } from "@wha.ts/core/src/client";
import { GenericAuthState } from "@wha.ts/core/src/state/providers/generic-auth-state";
import { createStorage } from "unstorage";
import fsDriver from "unstorage/drivers/fs-lite";
import localStorageDriver from "unstorage/drivers/localstorage";
import { renderUnicodeCompact } from "uqr";

const IS_BROWSER = typeof window !== "undefined";

const storage = IS_BROWSER
	? createStorage({ driver: localStorageDriver({ base: "wha.ts" }) })
	: createStorage({ driver: fsDriver({ base: "./storage" }) });

const authState = await GenericAuthState.init(storage);
async function runExample() {
	const client = createWAClient({
		auth: authState,
		logger: console,
	});

	client.addListener("connection.update", (update) => {
		console.log("[CONNECTION UPDATE]", JSON.stringify(update));

		const { connection, qr, isNewLogin, error } = update;

		if (qr) {
			console.log(renderUnicodeCompact(qr));
		}

		if (connection === "connecting") {
			console.log("🔌 Connecting...");
		}

		if (connection === "open") {
			console.log("✅ Connection successful!");
			console.log("   Your JID:", client.auth.creds.me?.id);
		}

		if (isNewLogin) {
			console.log("✨ Pairing successful (new login)!");
			console.log(
				"   Credentials saved. Waiting for server to close connection for restart...",
			);
		}

		if (connection === "close") {
			const reason = error?.message || "Unknown reason";

			console.log(`❌ Connection closed. Reason: ${reason}`);
		}
	});

	client.addListener("creds.update", () => {
		console.log("[CREDS UPDATE]", "Credentials were updated.");
	});

	client.addListener("message.received", async (messageData) => {
		console.info(messageData, "[Example] received message");

		const messageContent = messageData.message;
		const senderAddress = messageData.sender;

		const actualMessage =
			messageContent.deviceSentMessage?.message || messageContent;
		const conversationText =
			actualMessage.conversation || actualMessage.extendedTextMessage?.text;

		if (conversationText === "test") {
			const userJid = `${senderAddress.id}@s.whatsapp.net`;

			console.log(`Replying to ${userJid} (device ${senderAddress.deviceId})`);

			await new Promise((resolve) => setTimeout(resolve, 500));

			try {
				await client.sendTextMessage(
					userJid,
					"test-reply",
					senderAddress.deviceId,
				);
				console.log("[Example] Sent reply successfully.");
			} catch (error) {
				console.error("[Example] Failed to send reply:", error);
			}
		}
	});

	client.addListener("node.received", (node) => {
		console.log("[NODE RECEIVED]", node);
	});

	try {
		await client.connect();
		console.log(
			"Connection process initiated. Waiting for events (QR code or login success)...",
		);
	} catch (error) {
		console.error("💥 Failed to initiate connection:", error);
	}
}

runExample().catch((err) => {
	console.error("Unhandled error during script execution:", err);
});
