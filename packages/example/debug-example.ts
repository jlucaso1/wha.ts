import { decodeBinaryNode } from "@wha.ts/binary/src/decode";
import { createWAClient } from "@wha.ts/core/src/client";
import {
	FileSystemSimpleKeyValueStore,
	GenericAuthState,
} from "@wha.ts/storage";
import { renderUnicodeCompact } from "uqr";

import {
	type WhaTsCoreModules,
	initDebugController,
	startDebugAPIServer,
	startDebugREPL,
} from "@wha.ts/debug";

const IS_NODE =
	typeof process !== "undefined" &&
	process.versions != null &&
	process.versions.node != null;

async function main() {
	console.log("Starting Wha.ts Debug Example...");

	const storageDir = "./debug-example-storage";
	const fileStore = new FileSystemSimpleKeyValueStore(storageDir);
	const authState = await GenericAuthState.init(fileStore);

	console.log(
		`Authentication state initialized. Registered: ${
			authState.creds.registered
		}, User: ${authState.creds.me?.id || "None"}`,
	);

	const client = createWAClient({
		auth: authState,
		logger: console,
	});
	console.log("Wha.ts client created.");

	console.log("Setting up Debug Controller...");

	const coreModules: WhaTsCoreModules = {
		wsClient: (client as any).connectionManager?.ws,
		frameHandler: (client as any).connectionManager?.frameHandler,
		noiseProcessor: (client as any).connectionManager?.noiseProcessor,
		connectionManager: (client as any).connectionManager,
		authenticator: (client as any).authenticator,
		client: client,
		messageProcessor: (client as any).messageProcessor,
		decodeBinaryNode: decodeBinaryNode,
	};

	let allModulesFound = true;
	for (const [key, value] of Object.entries(coreModules)) {
		if (key === "decodeBinaryNode") continue;

		if (value === undefined) {
			console.warn(
				`[DebugSetup] Core module '${key}' is undefined. Debug hooks for this module might not work.`,
			);
			allModulesFound = false;
		}
	}
	if (!allModulesFound) {
		console.warn(
			"[DebugSetup] Some core modules were not found. Debugging capabilities may be limited. Ensure client internals are accessible as expected by this example.",
		);
	}

	const debugController = initDebugController(
		{
			networkLogCapacity: 500,
			clientEventCapacity: 200,
			errorLogCapacity: 100,
			stateSnapshotCapacity: 20,
		},
		coreModules,
	);
	console.log("Debug Controller initialized and hooks attached.");

	if (IS_NODE) {
		if (process.env.DEBUG_REPL?.toLowerCase() === "true") {
			console.log("Starting Debug REPL (DEBUG_REPL=true)...");
			startDebugREPL(debugController).catch((err) => {
				console.error("Failed to start Debug REPL:", err);
			});
		} else {
			console.log("Debug REPL not started. Set DEBUG_REPL=true to enable.");
		}

		if (process.env.DEBUG_API?.toLowerCase() === "true") {
			const apiPort = process.env.DEBUG_API_PORT
				? Number.parseInt(process.env.DEBUG_API_PORT, 10)
				: 7999;
			if (Number.isNaN(apiPort)) {
				console.error(
					`Invalid DEBUG_API_PORT: ${process.env.DEBUG_API_PORT}. Using default 7999.`,
				);
			}
			console.log(
				`Starting Debug API Server on port ${
					Number.isNaN(apiPort) ? 7999 : apiPort
				} (DEBUG_API=true)...`,
			);
			try {
				startDebugAPIServer({
					controller: debugController,
					port: Number.isNaN(apiPort) ? 7999 : apiPort,
				});
			} catch (err) {
				console.error("Failed to start Debug API Server:", err);
			}
		} else {
			console.log(
				"Debug API Server not started. Set DEBUG_API=true to enable.",
			);
		}
	} else {
		console.log(
			"Debug REPL and API Server are only available in Node.js environment.",
		);
	}

	client.addListener("connection.update", (update) => {
		console.log(
			"[CONNECTION UPDATE]",
			JSON.stringify(
				{
					...update,
					qr: update.qr ? "<QR_CODE_PRESENT>" : undefined,
					error: update.error ? update.error.message : undefined,
				},
				null,
				2,
			),
		);
		const { connection, qr, isNewLogin, error } = update;

		if (qr) {
			console.log("QR Code Received. Scan with WhatsApp:");
			console.log(renderUnicodeCompact(qr));
		}
		if (connection === "connecting") console.log("🔌 Client connecting...");
		if (connection === "open") {
			console.log("✅ Client connected!");
			console.log("   Your JID:", client.auth.creds.me?.id);
		}
		if (isNewLogin) {
			console.log(
				"✨ Pairing successful (new login)! Credentials saved. You might need to restart the client for full functionality if the server closes the connection.",
			);
		}
		if (connection === "close") {
			console.log(
				`❌ Client connection closed. Reason: ${error?.message || "Unknown"}`,
			);
		}
	});

	client.addListener("creds.update", () => {
		console.log(
			"[CREDS UPDATE]",
			"Credentials were updated. Current registration status:",
			client.auth.creds.registered,
		);
	});

	client.addListener("node.received", ({ node }) => {});

	client.addListener("message.received", async (messageData) => {
		const messageContent = messageData.message;
		const senderAddress = messageData.sender;
		const actualMessage =
			messageContent.deviceSentMessage?.message || messageContent;
		const conversationText =
			actualMessage.conversation || actualMessage.extendedTextMessage?.text;

		console.log(
			`[MESSAGE RECEIVED] From: ${senderAddress.toString()}, Text: "${conversationText}"`,
		);

		if (conversationText?.toLowerCase() === "ping-debug") {
			const userJid = `${senderAddress.id}@s.whatsapp.net`;
			console.log(
				`[DebugExample] Received "ping-debug". Replying with "pong-debug" to ${userJid}`,
			);
			try {
				await client.sendTextMessage(userJid, "pong-debug");
				console.log("[DebugExample] Sent 'pong-debug' reply successfully.");
			} catch (error) {
				console.error(
					"[DebugExample] Failed to send 'pong-debug' reply:",
					error,
				);
			}
		}
	});

	client.addListener("message.decryption_error", (data) => {
		console.error("[MESSAGE DECRYPTION ERROR]", {
			sender: data.sender?.toString(),
			error: data.error.message,
		});
	});

	try {
		console.log("Attempting to connect the client...");
		await client.connect();
		console.log(
			"Client connection process initiated. Monitor console for events (QR, connection status, messages).",
		);
	} catch (error) {
		console.error("💥 Failed to initiate client connection:", error);
		if (IS_NODE) process.exit(1);
	}

	if (
		IS_NODE &&
		(process.env.DEBUG_REPL?.toLowerCase() === "true" ||
			process.env.DEBUG_API?.toLowerCase() === "true")
	) {
		console.log(
			"Debug services are active. The application will remain running. Press Ctrl+C to exit.",
		);
	} else if (IS_NODE) {
		console.log(
			"Client connection attempt finished. If no REPL/API server is active and client disconnects, script may exit.",
		);
	}
	// Example: Send a message to self and print ACK/error result
	if (client.auth.creds.me?.id) {
		const selfJid = client.auth.creds.me.id;
		const messageText = "ok";
		console.log(`Sending "${messageText}" to yourself (${selfJid})...`);
		try {
			const result = await client.sendTextMessage(selfJid, messageText);
			if (result.error) {
				console.error(
					`Message sent (ID: ${result.messageId}) but server reported an error: ${result.error}`,
				);
				if (result.ack) console.error("Error ACK details:", result.ack.attrs);
			} else if (result.ack) {
				console.log(
					`Message sent (ID: ${result.messageId}) and acknowledged by server. Ack details: ${JSON.stringify(result.ack.attrs)}`,
				);
			} else {
				console.log(
					`Message sent (ID: ${result.messageId}), but ack status is unclear.`,
				);
			}
		} catch (e) {
			console.error("Failed to send message to self:", e);
		}
	}
}

main().catch((err) => {
	console.error("Unhandled error in main Wha.ts Debug Example execution:", err);
	if (IS_NODE) {
		process.exit(1);
	}
});
