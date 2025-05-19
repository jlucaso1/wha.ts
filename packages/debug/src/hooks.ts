import type { decodeBinaryNode } from "@wha.ts/binary/src/decode";
import type { DebugController } from "./controller";

// These types would ideally come from @wha.ts/core if they are exported,
// or need to be defined based on the actual class structures.
// For now, these are illustrative.
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
type AnyFunction = (...args: any[]) => any;
interface OriginalMethodsMap {
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	[componentKey: string]: { [methodName: string]: AnyFunction };
}
const originalMethods: OriginalMethodsMap = {};

// Define the structure of the core modules object
// This should be updated with actual types from @wha.ts/core
export interface WhaTsCoreModules {
	// biome-ignore lint/suspicious/noExplicitAny: For WebSocket client instance
	wsClient?: any;
	// biome-ignore lint/suspicious/noExplicitAny: For FrameHandler instance
	frameHandler?: any;
	// biome-ignore lint/suspicious/noExplicitAny: For NoiseProcessor instance
	noiseProcessor?: any;
	// biome-ignore lint/suspicious/noExplicitAny: For ConnectionManager instance
	connectionManager?: any;
	// biome-ignore lint/suspicious/noExplicitAny: For Authenticator instance
	authenticator?: any;
	// biome-ignore lint/suspicious/noExplicitAny: For WhaTSClient instance
	client?: any;
	// biome-ignore lint/suspicious/noExplicitAny: For MessageProcessor instance
	messageProcessor?: any;
	// Utility for decoding XMPP, assumed to be available or passed in
	decodeBinaryNode?: typeof decodeBinaryNode;
}

function storeOriginalMethod(
	componentKey: string,
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	instance: any,
	methodName: string,
) {
	if (!originalMethods[componentKey]) {
		originalMethods[componentKey] = {};
	}
	if (instance && typeof instance[methodName] === "function") {
		originalMethods[componentKey][methodName] =
			instance[methodName].bind(instance);
	}
}

function restoreOriginalMethod(
	componentKey: string,
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	instance: any,
	methodName: string,
) {
	if (
		originalMethods[componentKey]?.[methodName] &&
		instance &&
		typeof instance[methodName] === "function"
	) {
		instance[methodName] = originalMethods[componentKey][methodName];
	}
}

export function attachHooks(
	controller: DebugController,
	core: WhaTsCoreModules,
): void {
	// --- WebSocketClient debug events ---
	if (core.wsClient) {
		core.wsClient.addEventListener(
			"debug:websocket:sending_raw",
			(event: any) => {
				controller.recordNetworkEvent({
					direction: "send",
					layer: "websocket_raw",
					data: event.detail.data,
					length: event.detail.data.length,
				});
			},
		);
		core.wsClient.addEventListener(
			"debug:websocket:received_raw",
			(event: any) => {
				controller.recordNetworkEvent({
					direction: "receive",
					layer: "websocket_raw",
					data: event.detail.data,
					length: event.detail.data.length,
				});
			},
		);
	}

	// --- FrameHandler debug events ---
	if (core.frameHandler) {
		core.frameHandler.addEventListener(
			"debug:framehandler:payload_to_frame",
			(event: any) => {
				controller.recordNetworkEvent({
					direction: "send",
					layer: "noise_payload",
					data: event.detail.payload,
					length: event.detail.payload.length,
					metadata: { handshakeFinished: event.detail.isHandshakeFinished },
				});
			},
		);
		core.frameHandler.addEventListener(
			"debug:framehandler:framed_payload_sent",
			(event: any) => {
				controller.recordNetworkEvent({
					direction: "send",
					layer: "frame_raw",
					data: event.detail.framed,
					length: event.detail.framed.length,
				});
			},
		);
		core.frameHandler.addEventListener(
			"debug:framehandler:received_raw_frame",
			(event: any) => {
				controller.recordNetworkEvent({
					direction: "receive",
					layer: "frame_raw",
					data: event.detail.encryptedFrame,
					length: event.detail.encryptedFrame.length,
				});
			},
		);
	}

	// --- NoiseProcessor debug events ---
	if (core.noiseProcessor) {
		core.noiseProcessor.addEventListener(
			"debug:noiseprocessor:payload_encrypted",
			(event: any) => {
				controller.recordNetworkEvent({
					direction: "send",
					layer: "noise_payload",
					data: event.detail.ciphertext,
					length: event.detail.ciphertext.length,
					metadata: { plaintextLength: event.detail.plaintext.length },
				});
			},
		);
		core.noiseProcessor.addEventListener(
			"debug:noiseprocessor:payload_decrypted",
			(event: any) => {
				controller.recordNetworkEvent({
					direction: "receive",
					layer: "noise_payload",
					data: event.detail.plaintext,
					length: event.detail.plaintext.length,
					metadata: { ciphertextLength: event.detail.ciphertext.length },
				});
			},
		);
		core.noiseProcessor.addEventListener(
			"debug:noiseprocessor:state_update",
			(event: any) => {
				controller.recordComponentState(
					"noiseProcessor",
					event.detail.stateSnapshot,
				);
			},
		);
		// Initial state snapshot
		if (typeof core.noiseProcessor.getDebugStateSnapshot === "function") {
			controller.recordComponentState(
				"noiseProcessor",
				core.noiseProcessor.getDebugStateSnapshot(),
			);
		}
	}

	// --- ConnectionManager debug events ---
	if (core.connectionManager) {
		core.connectionManager.addEventListener(
			"debug:connectionmanager:sending_node",
			(event: any) => {
				controller.recordNetworkEvent({
					direction: "send",
					layer: "xmpp_node",
					data: event.detail.node,
					length: JSON.stringify(event.detail.node).length,
				});
			},
		);
		core.connectionManager.addEventListener("node.received", (event: any) => {
			controller.recordNetworkEvent({
				direction: "receive",
				layer: "xmpp_node",
				data: event.detail.node,
				length: JSON.stringify(event.detail.node).length,
			});
		});
		core.connectionManager.addEventListener("state.change", (event: any) => {
			controller.recordClientEvent(
				"connection_manager.state.change",
				event.detail,
				"ConnectionManager",
			);
			controller.recordComponentState("connectionManager", event.detail.state);
		});
		// Initial state snapshot
		if (typeof core.connectionManager.getDebugStateSnapshot === "function") {
			controller.recordComponentState(
				"connectionManager",
				core.connectionManager.getDebugStateSnapshot(),
			);
		}
	}

	// --- Authenticator debug events ---
	if (core.authenticator) {
		core.authenticator.addEventListener(
			"debug:authenticator:state_change",
			(event: any) => {
				controller.recordComponentState("authenticator", {
					state: event.detail.state,
					snapshot:
						typeof core.authenticator.getDebugStateSnapshot === "function"
							? core.authenticator.getDebugStateSnapshot()
							: undefined,
				});
			},
		);
		core.authenticator.addEventListener("connection.update", (event: any) => {
			controller.recordClientEvent(
				"authenticator.connection.update",
				event.detail,
				"Authenticator",
			);
		});
		core.authenticator.addEventListener("creds.update", (event: any) => {
			controller.recordClientEvent(
				"authenticator.creds.update",
				event.detail,
				"Authenticator",
			);
		});
		// Initial state snapshot
		if (typeof core.authenticator.getDebugStateSnapshot === "function") {
			controller.recordComponentState(
				"authenticator",
				core.authenticator.getDebugStateSnapshot(),
			);
		}
	}

	// --- WhaTSClient (High-level events) ---
	if (core.client) {
		const clientListener = (event: any) => {
			controller.recordClientEvent(
				`client.${event.type}`,
				event.detail,
				"WhaTSClient",
			);
		};
		const clientEventsToLog = [
			"connection.update",
			"creds.update",
			"message.received",
			"message.decryption_error",
			"node.received",
		];
		for (const eventName of clientEventsToLog) {
			(core.client as any).addEventListener(eventName, clientListener);
		}
		(core.client as any)._debugListener = clientListener;
	}

	// --- Message Processor ---
	if (core.messageProcessor) {
		core.messageProcessor.addEventListener(
			"message.decrypted",
			(event: any) => {
				controller.recordClientEvent(
					"message_processor.message.decrypted",
					{
						sender: event.detail.sender?.toString(),
						messageType: event.detail.message?.$typeName,
					},
					"MessageProcessor",
				);
			},
		);
		core.messageProcessor.addEventListener(
			"message.decryption_error",
			(event: any) => {
				controller.recordClientEvent(
					"message_processor.message.decryption_error",
					{
						sender: event.detail.sender?.toString(),
						error: event.detail.error?.message,
					},
					"MessageProcessor",
				);
				controller.recordError(
					"MessageProcessor.decryption",
					event.detail.error,
					{ rawNodeTag: event.detail.rawNode?.tag },
				);
			},
		);
	}
}

export function detachHooks(core: WhaTsCoreModules): void {
	if (core.wsClient) {
		restoreOriginalMethod("wsClient", core.wsClient, "send");
		restoreOriginalMethod("wsClient", core.wsClient, "dispatchEvent");
	}
	if (core.frameHandler) {
		restoreOriginalMethod(
			"frameHandler",
			core.frameHandler,
			"handleReceivedData",
		);
		restoreOriginalMethod("frameHandler", core.frameHandler, "framePayload");
	}
	if (core.noiseProcessor) {
		restoreOriginalMethod(
			"noiseProcessor",
			core.noiseProcessor,
			"decryptMessage",
		);
	}
	if (core.connectionManager) {
		restoreOriginalMethod(
			"connectionManager",
			core.connectionManager,
			"sendNode",
		);
		// Remove debug event listeners
		const cmKey = "connectionManager";
		if (
			originalMethods[cmKey]?._debugEventListeners &&
			typeof core.connectionManager.removeEventListener === "function"
		) {
			const listeners = (originalMethods[cmKey] as any)._debugEventListeners;
			for (const eventName in listeners) {
				core.connectionManager.removeEventListener(
					eventName,
					listeners[eventName],
				);
			}
			(originalMethods[cmKey] as any)._debugEventListeners = undefined;
		}
	}
	if (core.client && (core.client as any)._debugListener) {
		const clientEventsToLog = [
			"connection.update",
			"creds.update",
			"message.received",
			"message.decryption_error",
			"node.received",
		];
		for (const eventName of clientEventsToLog) {
			(core.client as any).removeEventListener(
				eventName,
				(core.client as any)._debugListener,
			);
		}
		(core.client as any)._debugListener = undefined;
	}

	for (const key in originalMethods) {
		delete originalMethods[key];
	}
	// --- Signal Protocol Store Adapter Cleanup ---
	if (core.client && (core.client as any).signalStore) {
		restoreOriginalMethod(
			"signalStore",
			(core.client as any).signalStore,
			"storeSession",
		);
		restoreOriginalMethod(
			"signalStore",
			(core.client as any).signalStore,
			"loadSession",
		);
	}
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
function deepClone(obj: any): any {
	if (obj === null || typeof obj !== "object") {
		return obj;
	}
	if (obj instanceof Uint8Array) {
		return new Uint8Array(obj);
	}
	if (obj instanceof Date) {
		return new Date(obj.getTime());
	}
	if (Array.isArray(obj)) {
		return obj.map((item: any) => deepClone(item));
	}
	const cloned: { [key: string]: any } = {};
	for (const key in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			cloned[key] = deepClone(obj[key]);
		}
	}
	return cloned;
}
