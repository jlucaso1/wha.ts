import { fromBinary, type JsonValue, toJson } from "@bufbuild/protobuf";
import { type BinaryNode, decodeBinaryNode } from "@wha.ts/binary";
import { FrameHandler } from "@wha.ts/core/transport/frame-handler";
import type { NoiseProcessor } from "@wha.ts/core/transport/noise-processor";
import type { ILogger } from "@wha.ts/core/transport/types";
import { ClientPayloadSchema, HandshakeMessageSchema } from "@wha.ts/proto";
import { base64ToBytes, bytesToHex, hexToBytes } from "@wha.ts/utils";

declare global {
	interface Window {
		decodeWhaTsNode?: (
			inputData: string,
			format?: "hex" | "base64",
		) => Promise<BinaryNode | undefined>;
	}
}

declare global {
	interface WebSocket {
		_whaTsPatched?: boolean;
		_whaTsOriginalOnMessage?:
			| ((this: WebSocket, ev: MessageEvent) => unknown)
			| null;
		_whaTsWrappedOnMessageGetterValue?:
			| ((this: WebSocket, ev: MessageEvent) => unknown)
			| null;
	}
}

const PROTO_SCHEMAS = [HandshakeMessageSchema, ClientPayloadSchema];

console.log("[Wha.ts Console POC] Content script injected.");

const consoleLogger: ILogger = {
	info: (obj: unknown, msg?: unknown) => console.log("[INFO]", msg, obj),
	error: (obj: unknown, msg?: unknown) => console.error("[ERROR]", msg, obj),
	warn: (obj: unknown, msg?: unknown) => console.warn("[WARN]", msg, obj),
	debug: (...data: unknown[]) => console.debug("[DEBUG]", ...data),
	trace: (...data: unknown[]) => console.trace("[TRACE]", ...data),
};

const passThroughNoiseProcessor = {
	isHandshakeFinished: true,
	encryptMessage: (plaintext: Uint8Array) => plaintext,
	decryptMessage: (ciphertext: Uint8Array) => ciphertext,
};

async function logExtractedPayload(payloadBytes: Uint8Array): Promise<void> {
	const timestamp = new Date().toLocaleTimeString();
	console.groupCollapsed(
		`%c[Wha.ts POC @ ${timestamp}] %c📦 De-framed Payload`,
		"color: #888; font-weight: normal;",
		"color: purple; font-weight: bold;",
	);

	try {
		console.log(
			`%cPayload Size:%c ${payloadBytes.length} bytes`,
			"color: black;",
			"font-weight: normal;",
		);
		console.log(
			"%cPayload Hexdump Snippet:%c %s...",
			"color: black;",
			"font-family: monospace;",
			bytesToHex(payloadBytes.slice(0, 128)),
		);

		const decodedNode = decodeBinaryNode(payloadBytes);
		console.log(
			"%c✅ Decoded as BinaryNode:",
			"color: green; font-weight: bold;",
			decodedNode,
		);
	} catch (nodeError) {
		const protoResult = tryDecodeWithKnownSchemas(payloadBytes);
		if (protoResult) {
			console.log(
				`%c✅ Decoded as ProtoBuf (%c${protoResult.schemaName}%c):`,
				"color: green; font-weight: bold;",
				"font-family: monospace; color: green;",
				"color: green; font-weight: bold;",
				protoResult.decoded,
			);
		} else {
			console.warn(
				"%c⚠️ Could not decode payload.",
				"color: orange; font-weight: bold;",
				"This is expected for encrypted messages, as the extension lacks decryption keys.",
			);
			console.error("Decoding error:", nodeError);
		}
	} finally {
		console.groupEnd();
	}
}

const receiveFrameHandler = new FrameHandler(
	passThroughNoiseProcessor as unknown as NoiseProcessor,
	consoleLogger,
	logExtractedPayload,
);

function tryDecodeWithKnownSchemas(
	payloadBytes: Uint8Array,
): { schemaName: string; decoded: JsonValue } | null {
	if (!payloadBytes || payloadBytes.length === 0) {
		return null;
	}
	for (const schema of PROTO_SCHEMAS) {
		try {
			const message = fromBinary(schema, payloadBytes);
			return { decoded: toJson(schema, message), schemaName: schema.typeName };
		} catch {}
	}
	return null;
}

async function logRawData(
	direction: "send" | "receive",
	data: unknown,
): Promise<void> {
	if (!(data instanceof ArrayBuffer)) return;

	const timestamp = new Date().toLocaleTimeString();
	const arrow = direction === "send" ? "⬆️ SEND" : "⬇️ RECV";
	const color = direction === "send" ? "blue" : "green";

	console.groupCollapsed(
		`%c[Wha.ts POC @ ${timestamp}] %c${arrow}`,
		"color: #888; font-weight: normal;",
		`color: ${color}; font-weight: bold;`,
	);
	try {
		const bytes = new Uint8Array(data);
		console.log(
			`%cRaw Frame Size:%c ${bytes.length} bytes`,
			"color: black;",
			"font-weight: normal;",
		);
		console.log(
			"%cHexdump Snippet (Raw Frame):%c %s...",
			"color: black;",
			"font-family: monospace;",
			bytesToHex(bytes.slice(0, 128)),
		);
	} catch (e) {
		console.error("Error logging raw data:", e);
	} finally {
		console.groupEnd();
	}
}

window.decodeWhaTsNode = async (
	inputData: string,
	format: "hex" | "base64" = "hex",
): Promise<BinaryNode | undefined> => {
	console.log(
		"%cManually decoding payload...",
		"color: purple; font-weight: bold;",
	);
	try {
		const bytes =
			format === "hex" ? hexToBytes(inputData) : base64ToBytes(inputData);
		const decodedNode = decodeBinaryNode(bytes);
		console.log(
			"%c✅ Manual Decode Success:",
			"color: green; font-weight: bold;",
			decodedNode,
		);
		return decodedNode;
	} catch (e) {
		console.error(
			"%c❌ Manual Decode Failed:",
			"color: red; font-weight: bold;",
			e,
		);
		return undefined;
	}
};
console.log(
	"[Wha.ts Console POC] Manual decode function available as `decodeWhaTsNode(payloadString, format?)`. Provide DECRYPTED and DE-FRAMED payload data only.",
);

try {
	const originalWebSocket = globalThis.WebSocket;
	if (originalWebSocket.prototype._whaTsPatched ?? false) {
		console.log("[Wha.ts Console POC] WebSocket already patched. Skipping.");
	} else {
		console.log("[Wha.ts Console POC] Attempting to patch WebSocket...");

		const originalSend = originalWebSocket.prototype.send;
		originalWebSocket.prototype.send = function (
			this: WebSocket,
			data: Parameters<WebSocket["send"]>[0],
		) {
			logRawData("send", data).catch((err) =>
				console.error("Error logging sent data:", err),
			);
			Reflect.apply(originalSend, this, [data]);
		};

		const originalAddEventListener =
			originalWebSocket.prototype.addEventListener;
		originalWebSocket.prototype.addEventListener = function (
			this: WebSocket,
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: boolean | AddEventListenerOptions,
		) {
			if (type === "message" && listener) {
				const wrappedListener = (event: MessageEvent) => {
					if (event.data instanceof ArrayBuffer) {
						receiveFrameHandler
							.handleReceivedData(new Uint8Array(event.data))
							.catch((err) => console.error("Error in FrameHandler:", err));
					}
					if (typeof listener === "function") {
						Reflect.apply(listener as EventListener, this, [event]);
					} else if (
						typeof (listener as EventListenerObject).handleEvent === "function"
					) {
						(listener as EventListenerObject).handleEvent.call(listener, event);
					}
				};
				Reflect.apply(originalAddEventListener, this, [
					type,
					wrappedListener,
					options,
				]);
			} else {
				Reflect.apply(originalAddEventListener, this, [
					type,
					listener,
					options,
				]);
			}
		};

		const onmessageDescriptor = Object.getOwnPropertyDescriptor(
			WebSocket.prototype,
			"onmessage",
		);
		if (onmessageDescriptor?.set) {
			const originalSetter = onmessageDescriptor.set;
			Object.defineProperty(WebSocket.prototype, "onmessage", {
				...onmessageDescriptor,
				set(this: WebSocket, listener: WebSocket["onmessage"]) {
					if (typeof listener === "function") {
						this._whaTsOriginalOnMessage = listener as (
							this: WebSocket,
							ev: MessageEvent,
						) => unknown;
						const wrappedListener = (event: MessageEvent) => {
							if (event.data instanceof ArrayBuffer) {
								receiveFrameHandler
									.handleReceivedData(new Uint8Array(event.data))
									.catch((err) =>
										console.error("Error in FrameHandler (onmessage):", err),
									);
							}
							Reflect.apply(
								listener as (this: WebSocket, ev: MessageEvent) => unknown,
								this,
								[event],
							);
						};
						this._whaTsWrappedOnMessageGetterValue = wrappedListener;
						Reflect.apply(originalSetter, this, [wrappedListener]);
					} else {
						this._whaTsOriginalOnMessage = null;
						this._whaTsWrappedOnMessageGetterValue = null;
						Reflect.apply(originalSetter, this, [listener]);
					}
				},
			});
		}

		Object.defineProperty(originalWebSocket.prototype, "_whaTsPatched", {
			value: true,
			writable: false,
			configurable: true,
			enumerable: false,
		});

		console.log("[Wha.ts Console POC] WebSocket patching complete.");
	}
} catch (err) {
	console.error("[Wha.ts Console POC] Failed to patch WebSocket:", err);
}
