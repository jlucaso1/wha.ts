import type { decodeBinaryNode } from "@wha.ts/binary";
import type { DebugController } from "./controller";

export interface WhaTsCoreModules {
	wsClient?: any;
	frameHandler?: any;
	noiseProcessor?: any;
	connectionManager?: any;
	authenticator?: any;
	client?: any;
	messageProcessor?: any;
	decodeBinaryNode?: typeof decodeBinaryNode;
}

export function attachHooks(
	controller: DebugController,
	core: WhaTsCoreModules,
): void {
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
		if (typeof core.noiseProcessor.getDebugStateSnapshot === "function") {
			controller.recordComponentState(
				"noiseProcessor",
				core.noiseProcessor.getDebugStateSnapshot(),
			);
		}
	}

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
		if (typeof core.connectionManager.getDebugStateSnapshot === "function") {
			controller.recordComponentState(
				"connectionManager",
				core.connectionManager.getDebugStateSnapshot(),
			);
		}
	}

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
		if (typeof core.authenticator.getDebugStateSnapshot === "function") {
			controller.recordComponentState(
				"authenticator",
				core.authenticator.getDebugStateSnapshot(),
			);
		}
	}

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
}
