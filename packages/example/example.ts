import { createWAClient } from "@wha.ts/core";
import { GenericAuthState } from "@wha.ts/storage";
import { pino } from "pino";
import { createStorage } from "unstorage";
import fsDriver from "unstorage/drivers/fs-lite";
import localStorageDriver from "unstorage/drivers/localstorage";
import { renderUnicodeCompact } from "uqr";

const IS_BROWSER = typeof window !== "undefined";

const storage = IS_BROWSER
	? createStorage({ driver: localStorageDriver({ base: "wha.ts" }) })
	: createStorage({ driver: fsDriver({ base: "./example-storage" }) });

const logger = pino({
	level: "debug",
	transport: {
		target: "pino-pretty",
		options: {
			colorize: true,
			ignore: "pid,hostname",
		},
	},
});

const authState = await GenericAuthState.init(storage);
async function runExample() {
	const client = createWAClient({
		auth: authState,
		logger: logger,
	});

	client.addListener("connection.update", (update) => {
		logger.debug("[CONNECTION UPDATE]", JSON.stringify(update));

		const { connection, qr, isNewLogin, error } = update;

		if (qr) {
			console.log(renderUnicodeCompact(qr));
		}

		if (connection === "connecting") {
			logger.info("🔌 Connecting...");
		}

		if (connection === "open") {
			logger.info("✅ Connection successful!");
			logger.info("   Your JID:", client.auth.creds.me?.id);
		}

		if (isNewLogin) {
			logger.info("✨ Pairing successful (new login)!");
			logger.info(
				"   Credentials saved. Waiting for server to close connection for restart...",
			);
		}

		if (connection === "close") {
			const reason = error?.message || "Unknown reason";

			console.log(`❌ Connection closed. Reason: ${reason}`);
		}
	});

	client.addListener("creds.update", () => {
		logger.info("[CREDS UPDATE]", "Credentials were updated.");
	});

	client.addListener("node.received", ({ node }) => {
		logger.info("[NODE RECEIVED]", {
			tag: node.tag,
			attrs: node.attrs,
		});
	});

	client.addListener("node.sent", ({ node }) => {
		logger.info("[NODE SENT]", {
			tag: node.tag,
			attrs: node.attrs,
		});
	});

	client.addListener("message.received", async (messageData) => {
		const messageContent = messageData.message;
		const senderAddress = messageData.sender;

		const actualMessage =
			messageContent.deviceSentMessage?.message || messageContent;
		const conversationText =
			actualMessage.conversation || actualMessage.extendedTextMessage?.text;

		if (conversationText === "test") {
			const userJid = `${senderAddress.id}@s.whatsapp.net`;

			logger.info(`Replying to ${userJid} (device ${senderAddress.deviceId})`);

			await new Promise((resolve) => setTimeout(resolve, 500));

			try {
				await client.sendTextMessage(userJid, "test-reply");
				logger.info("[Example] Sent reply successfully.");
			} catch (error) {
				logger.error("[Example] Failed to send reply:", error);
			}
		}
	});

	try {
		await client.connect();
		logger.info(
			"Connection process initiated. Waiting for events (QR code or login success)...",
		);
	} catch (error) {
		logger.error("💥 Failed to initiate connection:", error);
	}
}

runExample().catch((err) => {
	logger.error("Unhandled error during script execution:", err);
});
