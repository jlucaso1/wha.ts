import type { decodeBinaryNode } from "@wha.ts/binary/src/decode";
import type { BinaryNode } from "@wha.ts/binary/src/types";
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
	// --- WebSocket Raw Data ---
	if (core.wsClient) {
		const wsKey = "wsClient";
		storeOriginalMethod(wsKey, core.wsClient, "send");
		core.wsClient.send = async (data: Uint8Array) => {
			controller.recordNetworkEvent({
				direction: "send",
				layer: "websocket_raw",
				data: data,
				length: data.length,
			});
			try {
				// Ensure 'this' context is correct for the original method
				const origSend = originalMethods[wsKey]?.send;
				if (!origSend) throw new Error("Original wsClient.send is undefined");
				return await origSend.call(core.wsClient, data);
			} catch (e: unknown) {
				controller.recordNetworkEvent({
					direction: "send",
					layer: "websocket_raw",
					data: data,
					length: data.length,
					error: e instanceof Error ? e.message : String(e),
				});
				throw e;
			}
		};

		// Hook into message receiving. wsClient is an EventTarget.
		// We need to intercept 'message' events.
		// This assumes wsClient uses addEventListener like native WebSocket.
		storeOriginalMethod(wsKey, core.wsClient, "dispatchEvent"); // Or specific message handler
		const originalDispatchEvent = core.wsClient.dispatchEvent.bind(
			core.wsClient,
		);
		core.wsClient.dispatchEvent = (event: Event) => {
			if (event.type === "message" && event instanceof CustomEvent) {
				const data = event.detail as Uint8Array;
				if (data instanceof Uint8Array) {
					controller.recordNetworkEvent({
						direction: "receive",
						layer: "websocket_raw",
						data: data,
						length: data.length,
					});
				}
			}
			return originalDispatchEvent(event);
		};
	}

	// --- Frame Handler ---
	if (core.frameHandler) {
		const fhKey = "frameHandler";
		storeOriginalMethod(fhKey, core.frameHandler, "handleReceivedData");
		core.frameHandler.handleReceivedData = async (newData: Uint8Array) => {
			try {
				const origHandle = originalMethods[fhKey]?.handleReceivedData;
				if (!origHandle)
					throw new Error(
						"Original frameHandler.handleReceivedData is undefined",
					);
				return await origHandle.call(core.frameHandler, newData);
			} catch (e: unknown) {
				controller.recordError(
					"FrameHandler.handleReceivedData",
					e instanceof Error ? e : new Error(String(e)),
				);
				throw e;
			}
		};

		storeOriginalMethod(fhKey, core.frameHandler, "framePayload");
		core.frameHandler.framePayload = async (payload: Uint8Array) => {
			controller.recordNetworkEvent({
				direction: "send",
				layer: "noise_payload",
				data: payload,
				length: payload.length,
				metadata: {
					handshakeFinished: core.noiseProcessor?.isHandshakeFinished,
				},
			});
			try {
				const origFramePayload = originalMethods[fhKey]?.framePayload;
				if (!origFramePayload)
					throw new Error("Original frameHandler.framePayload is undefined");
				const framed = await origFramePayload.call(core.frameHandler, payload);
				controller.recordNetworkEvent({
					direction: "send",
					layer: "frame_raw",
					data: framed,
					length: framed.length,
				});
				return framed;
			} catch (e: unknown) {
				controller.recordError(
					"FrameHandler.framePayload",
					e instanceof Error ? e : new Error(String(e)),
				);
				throw e;
			}
		};
	}

	// --- Noise Processor ---
	if (core.noiseProcessor) {
		const npKey = "noiseProcessor";
		storeOriginalMethod(npKey, core.noiseProcessor, "decryptMessage");
		core.noiseProcessor.decryptMessage = async (ciphertext: Uint8Array) => {
			try {
				const origDecrypt = originalMethods[npKey]?.decryptMessage;
				if (!origDecrypt)
					throw new Error(
						"Original noiseProcessor.decryptMessage is undefined",
					);
				const plaintext = await origDecrypt.call(
					core.noiseProcessor,
					ciphertext,
				);
				controller.recordNetworkEvent({
					direction: "receive",
					layer: "noise_payload",
					data: plaintext,
					length: plaintext.length,
				});
				return plaintext;
			} catch (e: unknown) {
				controller.recordNetworkEvent({
					direction: "receive",
					layer: "noise_payload",
					data: ciphertext,
					length: ciphertext.length,
					error: e instanceof Error ? e.message : String(e),
				});
				controller.recordError(
					"NoiseProcessor.decryptMessage",
					e instanceof Error ? e : new Error(String(e)),
				);
				throw e;
			}
		};
	}

	// --- Connection Manager (XMPP Nodes) ---
	if (core.connectionManager) {
		const cmKey = "connectionManager";
		storeOriginalMethod(cmKey, core.connectionManager, "sendNode");
		core.connectionManager.sendNode = async (node: BinaryNode) => {
			controller.recordNetworkEvent({
				direction: "send",
				layer: "xmpp_node",
				data: deepClone(node),
				length: JSON.stringify(node).length,
			});
			try {
				const origSendNode = originalMethods[cmKey]?.sendNode;
				if (!origSendNode)
					throw new Error("Original connectionManager.sendNode is undefined");
				return await origSendNode.call(core.connectionManager, node);
			} catch (e: unknown) {
				controller.recordNetworkEvent({
					direction: "send",
					layer: "xmpp_node",
					data: deepClone(node),
					error: e instanceof Error ? e.message : String(e),
				});
				controller.recordError(
					"ConnectionManager.sendNode",
					e instanceof Error ? e : new Error(String(e)),
				);
				throw e;
			}
		};

		core.connectionManager.addEventListener("node.received", (event: any) => {
			const node = event.detail?.node as BinaryNode;
			if (node) {
				controller.recordNetworkEvent({
					direction: "receive",
					layer: "xmpp_node",
					data: deepClone(node),
					length: JSON.stringify(node).length,
				});
			}
		});

		core.connectionManager.addEventListener("state.change", (event: any) => {
			controller.recordClientEvent(
				"connection_manager.state.change",
				event.detail,
				"ConnectionManager",
			);
			controller.recordComponentState("connectionManager", event.detail.state);
		});
	}

	// --- Authenticator ---
	if (core.authenticator) {
		core.authenticator.addEventListener("connection.update", (event: any) => {
			controller.recordClientEvent(
				"authenticator.connection.update",
				event.detail,
				"Authenticator",
			);
			controller.recordComponentState(
				"authenticator",
				core.authenticator?.authStateProvider?.creds
					? {
							registered: core.authenticator.authStateProvider.creds.registered,
							me: core.authenticator.authStateProvider.creds.me,
							authState: (core.authenticator as any).state,
						}
					: "creds_unavailable",
			);
		});
		core.authenticator.addEventListener("creds.update", (event: any) => {
			controller.recordClientEvent(
				"authenticator.creds.update",
				event.detail,
				"Authenticator",
			);
			controller.recordComponentState(
				"authenticator",
				core.authenticator?.authStateProvider?.creds
					? {
							registered: core.authenticator.authStateProvider.creds.registered,
							me: core.authenticator.authStateProvider.creds.me,
						}
					: "creds_unavailable",
			);
		});
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

	// Initial state snapshots
	if (core.authenticator?.authStateProvider?.creds) {
		controller.recordComponentState(
			"authenticator",
			core.authenticator.authStateProvider.creds,
		);
	}
	if (core.noiseProcessor) {
		controller.recordComponentState(
			"noiseProcessor",
			(core.noiseProcessor as any).getState(),
		);
	}
	if (core.connectionManager) {
		controller.recordComponentState(
			"connectionManager",
			(core.connectionManager as any).state,
		);
	}
	// --- Signal Protocol Store Adapter Hooks ---
	if (core.client && (core.client as any).signalStore) {
		const signalStoreKey = "signalStore";
		const signalStoreInstance = (core.client as any).signalStore;

		// Hook storeSession
		storeOriginalMethod(signalStoreKey, signalStoreInstance, "storeSession");
		signalStoreInstance.storeSession = async (
			identifier: string,
			record: any,
		) => {
			const origStoreSession = originalMethods[signalStoreKey]?.storeSession;
			if (!origStoreSession) {
				throw new Error("Original signalStore.storeSession is undefined");
			}
			try {
				await origStoreSession.call(signalStoreInstance, identifier, record);
			} finally {
				controller.recordComponentState(`signal:session:${identifier}`, record);
			}
		};

		// Hook loadSession (optional, for observing what's loaded)
		storeOriginalMethod(signalStoreKey, signalStoreInstance, "loadSession");
		signalStoreInstance.loadSession = async (identifier: string) => {
			const origLoadSession = originalMethods[signalStoreKey]?.loadSession;
			if (!origLoadSession) {
				throw new Error("Original signalStore.loadSession is undefined");
			}
			const record = await origLoadSession.call(
				signalStoreInstance,
				identifier,
			);
			if (record) {
				controller.recordClientEvent(
					"signalStore.session.loaded",
					{ identifier, hasSession: !!record },
					"SignalStore",
				);
			}
			return record;
		};

		// Record identity state at hook time
		if (typeof signalStoreInstance.getOurIdentity === "function") {
			signalStoreInstance
				.getOurIdentity()
				.then((idKey: any) => {
					controller.recordComponentState("signal:identity", {
						registrationId:
							signalStoreInstance.authState?.creds?.registrationId,
						identityKey: idKey,
					});
				})
				.catch((e: Error) =>
					controller.recordError("SignalStore.getOurIdentity", e),
				);
		}
		if (signalStoreInstance.authState?.creds) {
			controller.recordComponentState("signal:identity", {
				registrationId: signalStoreInstance.authState.creds.registrationId,
				signedIdentityKey:
					signalStoreInstance.authState.creds.signedIdentityKey,
				signedPreKey: signalStoreInstance.authState.creds.signedPreKey,
				nextPreKeyId: signalStoreInstance.authState.creds.nextPreKeyId,
			});
		}

		controller.recordComponentState("signalStoreAdapter", {
			hooked: true,
			credsUsername: core.client.auth?.creds?.me?.id,
		});
	} else if (core.client) {
		console.warn(
			"[DebugHooks] core.client.signalStore not found. Signal state hooks will be disabled.",
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
