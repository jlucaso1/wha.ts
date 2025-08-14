import { createWAClient } from "@wha.ts/core";
import {
	FileSystemStorageDatabase,
	GenericAuthState,
	InMemoryStorageDatabase,
} from "@wha.ts/storage";
import {
	dumpAppStateSyncData,
	dumpDecryptionData,
} from "@wha.ts/storage/debug-dumper";
import type { IPlugin } from "@wha.ts/types";
import { pino } from "pino";
import { renderUnicodeCompact } from "uqr";

function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Uint8Array) {
		return `bytes(length: ${value.length})`;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	return value;
}

const IS_BROWSER = typeof window !== "undefined";

const storage = IS_BROWSER
	? new InMemoryStorageDatabase()
	: new FileSystemStorageDatabase("./example-storage");

const transport = IS_BROWSER
	? pino.transport({
			level: "debug",
			options: {
				colorize: true,
				ignore: "pid,hostname",
			},
			target: "pino-pretty",
		})
	: pino.transport({
			targets: [
				{
					options: {
						colorize: true,
						ignore: "pid,hostname",
					},
					target: "pino-pretty",
				},
				{
					level: "debug",
					options: {
						destination: "./example-log.txt",
						mkdir: true,
					},
					target: "pino/file",
				},
			],
		});

const logger = pino({ base: undefined }, transport);

const authState = await GenericAuthState.init(storage);

async function runExample() {
	const plugins: IPlugin[] = [];

	if (!IS_BROWSER && process.env.CAPTURE === "true") {
		const dumperPlugin: IPlugin = {
			install: (api) => {
				const appStateSyncRequestIds = new Set<string>();

				api.hooks.onPreDecrypt.tap((node) => {
					dumpDecryptionData(
						"./decryption-dumps",
						node,
						storage as FileSystemStorageDatabase,
					);
				});

				api.on("node.sent", ({ node }) => {
					if (
						node.tag === "iq" &&
						node.attrs.xmlns === "w:sync:app:state" &&
						node.attrs.type === "set" &&
						node.attrs.id
					) {
						appStateSyncRequestIds.add(node.attrs.id);
						api.logger.info(
							`[AppStateDumper] Watching for response to sync request ID: ${node.attrs.id}`,
						);
					}
				});

				api.on("node.received", ({ node }) => {
					if (
						node.tag === "iq" &&
						node.attrs.type === "result" &&
						node.attrs.id &&
						appStateSyncRequestIds.has(node.attrs.id)
					) {
						api.logger.info(
							`[AppStateDumper] Capturing sync response for ID: ${node.attrs.id}`,
						);
						dumpAppStateSyncData("./decryption-dumps", node);
						appStateSyncRequestIds.delete(node.attrs.id);
					}
				});

				api.logger.warn(
					"[DEBUG] Decryption bundle dumping is ENABLED. Saving to: ./decryption-dumps",
				);
			},
			name: "debug-dumper-plugin",
			version: "1.0.0",
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
				attrs: node.attrs,
				content: JSON.stringify(node.content, replacer),
				tag: node.tag,
			},
			"[NODE RECEIVED]",
		);
	});

	client.addListener("node.sent", ({ node }) => {
		logger.info(
			{
				attrs: node.attrs,
				content: JSON.stringify(node.content, replacer),
				tag: node.tag,
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
