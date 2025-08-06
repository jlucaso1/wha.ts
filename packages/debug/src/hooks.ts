import type { decodeBinaryNode } from "@wha.ts/binary";
import type { WhaTSClient } from "@wha.ts/core/client";
import type { ClientEventMap } from "@wha.ts/core/client-events";
import type { Authenticator } from "@wha.ts/core/core/authenticator";
import type { ConnectionManager } from "@wha.ts/core/core/connection";
import type { MessageProcessor } from "@wha.ts/core/messaging/message-processor";
import type { FrameHandler } from "@wha.ts/core/transport/frame-handler";
import type { NoiseProcessor } from "@wha.ts/core/transport/noise-processor";
import type { NativeWebSocketClient } from "@wha.ts/core/transport/websocket";
import type { DebugController } from "./controller";

export interface WhaTsCoreModules {
	wsClient?: NativeWebSocketClient;
	frameHandler?: FrameHandler;
	noiseProcessor?: NoiseProcessor;
	connectionManager?: ConnectionManager;
	authenticator?: Authenticator;
	client?: WhaTSClient;
	messageProcessor?: MessageProcessor;
	decodeBinaryNode?: typeof decodeBinaryNode;
}

export function attachHooks(
	controller: DebugController,
	core: WhaTsCoreModules,
): void {
	if (core.wsClient) {
		core.wsClient.addEventListener("sent", (event) => {
			controller.recordNetworkEvent({
				direction: "send",
				layer: "websocket_raw",
				data: event.detail.data,
				length: event.detail.data.length,
			});
		});
		core.wsClient.addEventListener("received", (event) => {
			controller.recordNetworkEvent({
				direction: "receive",
				layer: "websocket_raw",
				data: event.detail.data,
				length: event.detail.data.length,
			});
		});
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
		core.connectionManager.addEventListener("node.sent", (event) => {
			controller.recordNetworkEvent({
				direction: "send",
				layer: "xmpp_node",
				data: event.detail.node,
				length: JSON.stringify(event.detail.node).length,
			});
		});
		core.connectionManager.addEventListener("node.received", (event) => {
			controller.recordNetworkEvent({
				direction: "receive",
				layer: "xmpp_node",
				data: event.detail.node,
				length: JSON.stringify(event.detail.node).length,
			});
		});
		core.connectionManager.addEventListener("state.change", (event) => {
			controller.recordClientEvent(
				"connection_manager.state.change",
				event.detail,
				"ConnectionManager",
			);
			controller.recordComponentState("connectionManager", event.detail.state);
		});
		controller.recordComponentState(
			"connectionManager",
			core.connectionManager.getDebugStateSnapshot(),
		);
	}

	if (core.authenticator) {
		core.authenticator.addEventListener("connection.update", (event) => {
			controller.recordClientEvent(
				"authenticator.connection.update",
				event.detail,
				"Authenticator",
			);
		});
		core.authenticator.addEventListener("creds.update", (event) => {
			controller.recordClientEvent(
				"authenticator.creds.update",
				event.detail,
				"Authenticator",
			);
		});
		controller.recordComponentState(
			"authenticator",
			core.authenticator.getDebugStateSnapshot(),
		);
	}

	if (core.client) {
		const clientListener = (event: any) => {
			controller.recordClientEvent(
				`client.${event.type}`,
				event.detail,
				"WhaTSClient",
			);
		};
		const clientEventsToLog: (keyof ClientEventMap)[] = [
			"connection.update",
			"creds.update",
			"message.received",
			"message.decryption_error",
			"node.received",
			"node.sent",
		];
		for (const eventName of clientEventsToLog) {
			core.client.addEventListener(eventName, clientListener);
		}

		(core.client as any)._debugListener = clientListener;
	}

	if (core.messageProcessor) {
		core.messageProcessor.addEventListener("message.decrypted", (event) => {
			controller.recordClientEvent(
				"message_processor.message.decrypted",
				{
					sender: event.detail.sender?.toString(),
					messageType: event.detail.message?.$typeName,
				},
				"MessageProcessor",
			);
		});
		core.messageProcessor.addEventListener(
			"message.decryption_error",
			(event) => {
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
		] as const;
		for (const eventName of clientEventsToLog) {
			core.client.removeEventListener(
				eventName,
				(core.client as any)._debugListener,
			);
		}
		(core.client as any)._debugListener = undefined;
	}
}
