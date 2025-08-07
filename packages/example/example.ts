import { createWAClient } from "@wha.ts/core";
import {
	FileSystemStorageDatabase,
	GenericAuthState,
	InMemoryStorageDatabase,
} from "@wha.ts/storage";
import { dumpDecryptionData } from "@wha.ts/storage/debug-dumper";
import { serialize } from "@wha.ts/storage/serialization";
import type { IPlugin } from "@wha.ts/types";
import { pino } from "pino";
import { renderUnicodeCompact } from "uqr";

const IS_BROWSER = typeof window !== "undefined";

const storage = IS_BROWSER
	? new InMemoryStorageDatabase()
	: new FileSystemStorageDatabase("./example-storage");

const transport = IS_BROWSER
	? pino.transport({
			target: "pino-pretty",
			level: "debug",
			options: {
				colorize: true,
				ignore: "pid,hostname",
			},
		})
	: pino.transport({
			targets: [
				{
					target: "pino-pretty",
					options: {
						colorize: true,
						ignore: "pid,hostname",
					},
				},
				{
					level: "debug",
					target: "pino/file",
					options: {
						destination: "./example-log.txt",
						mkdir: true,
					},
				},
			],
		});

const logger = pino({ base: undefined }, transport);

const authState = await GenericAuthState.init(storage);

async function runExample() {
	const plugins: IPlugin[] = [];

	if (!IS_BROWSER && process.env.CAPTURE === "true") {
		const dumperPlugin: IPlugin = {
			name: "debug-dumper-plugin",
			version: "1.0.0",
			install: (api) => {
				api.hooks.onPreDecrypt.tap((node) => {
					dumpDecryptionData(
						"./decryption-dumps",
						node,
						storage as FileSystemStorageDatabase,
					);
				});
				api.logger.warn(
					"[DEBUG] Decryption bundle dumping is ENABLED. Saving to: ./decryption-dumps",
				);
			},
		};
		plugins.push(dumperPlugin);
	}

	const client = createWAClient({
		auth: authState,
		logger: logger,
		plugins: plugins,
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
		logger.info(
			{
				tag: node.tag,
				attrs: node.attrs,
				content: serialize(node.content),
			},
			"[NODE RECEIVED]",
		);
	});

	client.addListener("node.sent", ({ node }) => {
		logger.info(
			{
				tag: node.tag,
				attrs: node.attrs,
			},
			"[NODE SENT]",
		);
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
