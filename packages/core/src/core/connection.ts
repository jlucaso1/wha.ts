import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { decodeBinaryNode } from "@wha.ts/binary/src/decode";
import { encodeBinaryNode } from "@wha.ts/binary/src/encode";
import { S_WHATSAPP_NET } from "@wha.ts/binary/src/jid-utils";
import { getBinaryNodeChild } from "@wha.ts/binary/src/node-utils";
import type { BinaryNode } from "@wha.ts/binary/src/types";
import {
	type ClientPayload,
	ClientPayloadSchema,
	HandshakeMessageSchema,
} from "@wha.ts/proto";
import { bytesToHex, utf8ToBytes } from "@wha.ts/utils/src/bytes-utils";
import { DEFAULT_SOCKET_CONFIG, NOISE_WA_HEADER } from "../defaults";
import { TypedEventTarget } from "../generics/typed-event-target";
import type { MessageProcessor } from "../messaging/message-processor";
import type { AuthenticationCreds } from "../state/interface";
import { generateMdTagPrefix } from "../state/utils";
import { FrameHandler } from "../transport/frame-handler";
import { NoiseProcessor } from "../transport/noise-processor";
import type { ILogger, WebSocketConfig } from "../transport/types";
import { NativeWebSocketClient } from "../transport/websocket";
import {
	generateLoginPayload,
	generateRegisterPayload,
} from "./auth-payload-generators";
import type {
	ConnectionManagerEventMap,
	StateChangePayload,
} from "./connection-events";

class ConnectionManager extends TypedEventTarget<ConnectionManagerEventMap> {
	private logger: ILogger;
	private config: WebSocketConfig;
	private state: "connecting" | "open" | "handshaking" | "closing" | "closed" =
		"closed";
	private routingInfo?: Uint8Array;
	private creds: AuthenticationCreds;

	private ws!: NativeWebSocketClient;
	private noiseProcessor!: NoiseProcessor;
	private frameHandler!: FrameHandler;
	private epoch = 0;

	private messageProcessor!: MessageProcessor;

	constructor(
		wsConfig: Partial<WebSocketConfig>,
		logger: ILogger,
		creds: AuthenticationCreds,
		messageProcessor: MessageProcessor,
	) {
		super();
		this.logger = logger;
		this.config = { ...DEFAULT_SOCKET_CONFIG, ...wsConfig } as WebSocketConfig;
		this.creds = creds;
		this.routingInfo = creds.routingInfo;
		this.messageProcessor = messageProcessor;

		this.initializeConnectionComponents();
	}

	private initializeConnectionComponents(): void {
		this.logger.info("Initializing connection components...");

		this.noiseProcessor = new NoiseProcessor({
			localStaticKeyPair: this.creds.pairingEphemeralKeyPair,
			noisePrologue: NOISE_WA_HEADER,
			logger: this.logger,
			routingInfo: this.routingInfo,
		});

		this.frameHandler = new FrameHandler(
			this.noiseProcessor,
			this.logger,
			this.handleDecryptedFrame,
			this.routingInfo,
			NOISE_WA_HEADER,
		);

		if (this.ws) {
			this.removeWsListeners();
		}
		this.ws = new NativeWebSocketClient(this.config.url, this.config);

		this.setupWsListeners();

		this.frameHandler.resetFramingState();
	}

	private setState(newState: typeof this.state, error?: Error): void {
		if (this.state !== newState) {
			this.state = newState;
			const payload: StateChangePayload = { state: newState, error };
			this.dispatchTypedEvent("state.change", payload);
		}
	}

	private setupWsListeners(): void {
		this.ws.addEventListener("open", this.handleWsOpen);
		this.ws.addEventListener("message", ((event: Event) => {
			if (event instanceof CustomEvent) {
				this.handleWsMessage(event.detail);
			}
		}) as EventListener);
		this.ws.addEventListener("error", ((event: Event) => {
			if (event instanceof CustomEvent) {
				this.handleWsError(event.detail);
			}
		}) as EventListener);
		this.ws.addEventListener("close", ((event: Event) => {
			if (event instanceof CustomEvent) {
				this.handleWsClose(event.detail.code, event.detail.reason);
			}
		}) as EventListener);
	}

	private removeWsListeners(): void {
		this.ws.removeEventListener("open", this.handleWsOpen);
	}

	async connect(): Promise<void> {
		if (this.state !== "closed") {
			this.logger.warn(
				{ state: this.state },
				"Connect called on non-closed connection",
			);
			return;
		}
		this.setState("connecting");
		try {
			await this.ws.connect();
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			this.logger.error({ err: error }, "WebSocket connection failed");
			this.setState("closed", error);
			this.dispatchTypedEvent("error", { error });
			throw error;
		}
	}

	private handleWsOpen = async (): Promise<void> => {
		this.setState("handshaking");

		try {
			const handshakeMsg = this.noiseProcessor.generateInitialHandshakeMessage(
				this.creds.pairingEphemeralKeyPair,
			);

			const frame = await this.frameHandler.framePayload(handshakeMsg);
			await this.ws.send(frame);
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			this.logger.error({ err: error }, "Noise handshake initiation failed");
			this.close(error);
		}
	};

	private handleHandshakeData = async (data: Uint8Array): Promise<void> => {
		try {
			const handshakeMsg = fromBinary(HandshakeMessageSchema, data);

			if (handshakeMsg.serverHello) {
				const clientFinishStatic = await this.noiseProcessor.processHandshake(
					data,
					this.creds.noiseKey,
					this.creds.pairingEphemeralKeyPair,
				);
				let clientPayload: ClientPayload;
				if (this.creds.me?.id) {
					clientPayload = generateLoginPayload(this.creds.me.id);
				} else {
					clientPayload = generateRegisterPayload(this.creds);
				}

				const clientPayloadBytes = toBinary(ClientPayloadSchema, clientPayload);

				const payloadEnc =
					await this.noiseProcessor.encryptMessage(clientPayloadBytes);

				const clientFinishMsg = create(HandshakeMessageSchema, {
					clientFinish: {
						static: clientFinishStatic,
						payload: payloadEnc,
					},
				});

				const finishPayloadBytes = toBinary(
					HandshakeMessageSchema,
					clientFinishMsg,
				);

				const frame = await this.frameHandler.framePayload(finishPayloadBytes);
				await this.ws.send(frame);

				this.noiseProcessor.finalizeHandshake();

				this.setState("open");
				this.dispatchTypedEvent("handshake.complete", {});
			} else {
				throw new Error("Received unexpected message during handshake");
			}
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			this.logger.error({ err: error }, "Noise handshake processing failed");
			this.close(error);
		}
	};

	private handleWsMessage = async (data: Uint8Array): Promise<void> => {
		try {
			await this.frameHandler.handleReceivedData(data);
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			this.logger.error(
				{ dataLength: data.length, err: error },
				"Noise frame decoding/decryption failed",
			);
			this.dispatchTypedEvent("error", { error });
		}
	};

	private handleDecryptedFrame = async (
		decryptedPayload: Uint8Array,
	): Promise<void> => {
		if (this.state !== "open" && this.state !== "handshaking") {
			this.logger.warn(
				{ state: this.state },
				"Received data in unexpected state, ignoring",
			);
			return;
		}

		if (this.state === "handshaking") {
			this.handleHandshakeData(decryptedPayload).catch((err) => {
				this.logger.error({ err }, "Error in async handshake data handler");
				this.close(err);
			});
			return;
		}

		// If state is 'open'
		if (this.state === "open") {
			try {
				const node = decodeBinaryNode(decryptedPayload);

				// Handle pings directly in ConnectionManager
				if (
					node.tag === "iq" &&
					node.attrs.from === S_WHATSAPP_NET &&
					node.attrs.type === "get" &&
					node.attrs.xmlns === "urn:xmpp:ping"
				) {
					this.logger.debug({ id: node.attrs.id }, "Responding to ping");
					const pongNode: BinaryNode = {
						tag: "iq",
						attrs: {
							to: node.attrs.from,
							type: "result",
							xmlns: "w:p",
							id: `${generateMdTagPrefix()}-${this.epoch++}`,
						},
					};
					this.sendNode(pongNode).catch((err) => {
						this.logger.warn(
							{ err, id: node.attrs.id },
							"Failed to send pong response",
						);
					});
					return;
				}

				// Check if it's an encrypted message node
				const isEncryptedMessage =
					node.tag === "message" && getBinaryNodeChild(node, "enc");

				if (isEncryptedMessage) {
					// Route to MessageProcessor
					this.messageProcessor.processIncomingNode(node).catch((err) => {
						this.logger.error(
							{ err, nodeTag: node.tag, from: node.attrs.from },
							"Error processing encrypted node in MessageProcessor",
						);
					});
					// DO NOT dispatch 'node.received' for the raw encrypted message here
				} else {
					// Dispatch other nodes (receipts, notifications, non-encrypted messages, specific IQs)
					this.dispatchTypedEvent("node.received", { node });
				}
			} catch (error) {
				if (!(error instanceof Error)) {
					throw error;
				}
				this.logger.error(
					{ err: error, data: bytesToHex(decryptedPayload) },
					"Failed to decode BinaryNode from decrypted frame in 'open' state",
				);
				this.dispatchTypedEvent("error", { error });
			}
		}
	};

	async sendNode(node: BinaryNode): Promise<void> {
		if (this.state !== "open") {
			throw new Error(
				`Cannot send node while connection state is "${this.state}"`,
			);
		}

		try {
			const buffer = encodeBinaryNode(node);
			const frame = await this.frameHandler.framePayload(buffer);
			await this.ws.send(frame);
			this.dispatchTypedEvent("node.sent", { node });
		} catch (error) {
			this.logger.error({ err: error, node }, "Failed to send node");
			throw error;
		}
	}

	private handleWsError = (error: Error): void => {
		this.logger.error({ err: error }, "WebSocket error occurred");
		this.dispatchTypedEvent("error", { error });
		this.close(error);
	};

	private handleWsClose = (code: number, reasonBuffer: Uint8Array): void => {
		const reason = reasonBuffer.toString();
		const error =
			this.state !== "closing"
				? new Error(`WebSocket closed unexpectedly: ${code} ${reason}`)
				: undefined;
		this.setState(
			"closed",
			error ||
				(this.state === "closing"
					? undefined
					: new Error("Unknown close reason")),
		);
		this.removeWsListeners();
		this.dispatchTypedEvent("ws.close", { code, reason });
		if (error) this.dispatchTypedEvent("error", { error });
	};

	async close(error?: Error): Promise<void> {
		if (this.state === "closing" || this.state === "closed") {
			return;
		}
		this.setState("closing", error);
		try {
			const closeCode = 1000;
			const closeReason = error?.message || "User initiated close";

			await this.ws.close(closeCode, closeReason);
		} catch (wsError) {
			if (!(wsError instanceof Error)) {
				throw wsError;
			}
			this.logger.error(
				{ err: wsError },
				"Error explicitly closing WebSocket in ConnectionManager",
			);
			this.handleWsClose(1011, utf8ToBytes("Forced close after error"));
		}
	}

	async reconnect(): Promise<void> {
		this.logger.info("Attempting to reconnect...");
		try {
			if (this.state !== "closed") {
				this.logger.info(
					`Current state is ${this.state}, closing before reconnect...`,
				);
				await this.close(new Error("Reconnection requested"));
				this.logger.warn("Waiting for connection to fully close...");
				await new Promise<void>((resolve) => {
					const listener = () => resolve();
					this.addEventListener("ws.close", listener, { once: true });

					this.removeEventListener("ws.close", listener);
					this.logger.warn("Timeout waiting for close, proceeding anyway.");
					resolve();
				});
			} else {
				this.logger.info("Connection already closed, proceeding to reconnect.");
			}

			this.logger.info(
				"Re-initializing connection components for reconnect...",
			);
			this.initializeConnectionComponents();

			this.logger.info("Initiating connection...");
			await this.connect();

			this.logger.info("Reconnect attempt initiated successfully.");
		} catch (error) {
			this.logger.error({ err: error }, "Reconnect attempt failed");
			throw error;
		}
	}
}

export { ConnectionManager };
