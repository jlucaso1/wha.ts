import { decodeBinaryNode } from "@wha.ts/binary/src/decode"; // For WhaTsCoreModules
import { createWAClient } from "@wha.ts/core/src/client";
import { GenericAuthState } from "@wha.ts/core/src/state/providers/generic-auth-state";
import { createStorage } from "unstorage";
import fsDriver from "unstorage/drivers/fs-lite"; // For Node.js
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

// --- Storage Setup ---
// Use a separate storage directory for this debug example to avoid conflicts
const storage = IS_NODE
	? createStorage({ driver: fsDriver({ base: "./debug-example-storage" }) })
	: createStorage(); // Basic in-memory/localstorage for browser fallback

async function main() {
	console.log("Starting Wha.ts Debug Example...");

	// --- Auth State Setup ---
	const authState = await GenericAuthState.init(storage);
	console.log(
		`Authentication state initialized. Registered: ${
			authState.creds.registered
		}, User: ${authState.creds.me?.id || "None"}`,
	);

	// --- Wha.ts Client Setup ---
	const client = createWAClient({
		auth: authState,
		logger: console, // Use standard console for logging for this example
	});
	console.log("Wha.ts client created.");

	// --- DEBUG SETUP ---
	console.log("Setting up Debug Controller...");

	// Accessing internal modules. This is for debugging purposes and might break
	// with internal refactoring of @wha.ts/core.
	// The types in WhaTsCoreModules are 'any' to allow this, but we know
	// the underlying types from the core package.
	const coreModules: WhaTsCoreModules = {
		// wsClient is the NativeWebSocketClient instance inside ConnectionManager
		wsClient: (client as any).connectionManager?.ws,
		frameHandler: (client as any).connectionManager?.frameHandler,
		noiseProcessor: (client as any).connectionManager?.noiseProcessor,
		connectionManager: (client as any).connectionManager,
		authenticator: (client as any).authenticator,
		client: client, // The WhaTSClient instance itself
		messageProcessor: (client as any).messageProcessor,
		decodeBinaryNode: decodeBinaryNode, // The actual function
	};

	// Verify that crucial modules are found
	let allModulesFound = true;
	for (const [key, value] of Object.entries(coreModules)) {
		if (key === "decodeBinaryNode") continue; // decodeBinaryNode is a function, always present if imported

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
			// Optional: Customize buffer capacities
			networkLogCapacity: 500,
			clientEventCapacity: 200,
			errorLogCapacity: 100,
			stateSnapshotCapacity: 20,
		},
		coreModules, // This attaches the hooks automatically
	);
	console.log("Debug Controller initialized and hooks attached.");

	if (IS_NODE) {
		// Start REPL if DEBUG_REPL environment variable is set to "true"
		if (process.env.DEBUG_REPL?.toLowerCase() === "true") {
			console.log("Starting Debug REPL (DEBUG_REPL=true)...");
			// Not awaiting, so it runs in the background
			startDebugREPL(debugController).catch((err) => {
				console.error("Failed to start Debug REPL:", err);
			});
		} else {
			console.log("Debug REPL not started. Set DEBUG_REPL=true to enable.");
		}

		// Start API Server if DEBUG_API environment variable is set to "true"
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
	// ---- END DEBUG SETUP ----

	// --- Client Event Listeners (similar to example.ts) ---
	client.addListener("connection.update", (update) => {
		console.log(
			"[CONNECTION UPDATE]",
			JSON.stringify(
				{
					...update,
					qr: update.qr ? "<QR_CODE_PRESENT>" : undefined, // Avoid logging full QR to console
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
			// Example: send a test message to yourself if you want
			// if (client.auth.creds.me?.id) {
			//    client.sendTextMessage(client.auth.creds.me.id, "Wha.ts client connected with debug tools!");
			// }
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

	client.addListener("node.received", ({ node }) => {
		// This can be very verbose, usually handled by debug logs if enabled.
		// console.log("[NODE RECEIVED]", { tag: node.tag, attrs: node.attrs });
	});

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

		// Example auto-reply for testing
		if (conversationText?.toLowerCase() === "ping-debug") {
			const userJid = `${senderAddress.id}@s.whatsapp.net`; // Construct full JID
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
			// rawNode: data.rawNode // Log raw node if needed, can be very verbose
		});
	});

	// --- Connect Client ---
	try {
		console.log("Attempting to connect the client...");
		await client.connect();
		console.log(
			"Client connection process initiated. Monitor console for events (QR, connection status, messages).",
		);
	} catch (error) {
		console.error("💥 Failed to initiate client connection:", error);
		if (IS_NODE) process.exit(1); // Exit if initial connection fails catastrophically in Node
	}

	// Keep the process alive if in Node.js and REPL/API is running,
	// otherwise the script might exit after connect() if no other async ops are pending.
	if (
		IS_NODE &&
		(process.env.DEBUG_REPL?.toLowerCase() === "true" ||
			process.env.DEBUG_API?.toLowerCase() === "true")
	) {
		console.log(
			"Debug services are active. The application will remain running. Press Ctrl+C to exit.",
		);
		// The REPL or API server will keep the Node.js process alive.
		// If neither is active, and the client disconnects, the script might end.
	} else if (IS_NODE) {
		console.log(
			"Client connection attempt finished. If no REPL/API server is active and client disconnects, script may exit.",
		);
	}
}

main().catch((err) => {
	console.error("Unhandled error in main Wha.ts Debug Example execution:", err);
	if (IS_NODE) {
		process.exit(1);
	}
});
