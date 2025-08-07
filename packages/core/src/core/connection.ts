import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { BinaryNode } from "@wha.ts/binary";
import { decodeBinaryNode, encodeBinaryNode } from "@wha.ts/binary";
import {
	type ClientPayload,
	ClientPayloadSchema,
	HandshakeMessageSchema,
} from "@wha.ts/proto";
import type { AuthenticationCreds } from "@wha.ts/types";
import { bytesToHex, utf8ToBytes } from "@wha.ts/utils";
import {
	type TypedCustomEvent,
	TypedEventTarget,
} from "../../../types/src/generics/typed-event-target";
import { DEFAULT_SOCKET_CONFIG, NOISE_WA_HEADER } from "../defaults";
import type { MessageProcessor } from "../messaging/message-processor";
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
	ConnectionState,
	StateChangePayload,
} from "./connection-events";
import { IncomingNodeHandler } from "./incoming-node-handler";

class ConnectionManager extends TypedEventTarget<ConnectionManagerEventMap> {
	private logger: ILogger;
	private config: WebSocketConfig;
	private state: ConnectionState = "closed";
	private routingInfo?: Uint8Array;
	private creds: AuthenticationCreds;

	private ws!: NativeWebSocketClient;
	private noiseProcessor!: NoiseProcessor;
	private frameHandler!: FrameHandler;
	private nodeHandler!: IncomingNodeHandler;

	private messageProcessor!: MessageProcessor;

	private closingError?: Error;

	private handleWsOpenEvent = () => this.handleWsOpen();
	private handleWsMessageEvent = (
		event: TypedCustomEvent<{ data: Uint8Array }>,
	) => {
		this.handleWsMessage(event.detail.data);
	};
	private handleWsErrorEvent = (event: TypedCustomEvent<Error>) => {
		this.handleWsError(event.detail);
	};
	private handleWsCloseEvent = (
		event: TypedCustomEvent<{ code: number; reason: string }>,
	) => {
		const { code, reason } = event.detail;
		this.handleWsClose(code, utf8ToBytes(reason));
	};

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

		this.nodeHandler = new IncomingNodeHandler(
			{
				setState: this.setState.bind(this),
				sendNode: this.sendNode.bind(this),
				close: this.close.bind(this),
				dispatchTypedEvent: this.dispatchTypedEvent.bind(this),
			},
			this.messageProcessor,
			this.logger,
		);

		if (this.ws) {
			this.removeWsListeners();
		}

		this.ws = new NativeWebSocketClient(this.config.url, this.config);
		this.setupWsListeners();

		this.frameHandler.resetFramingState();
	}

	private setupWsListeners(): void {
		this.ws.addEventListener("open", this.handleWsOpenEvent);
		this.ws.addEventListener(
			"received",
			this.handleWsMessageEvent as EventListener,
		);
		this.ws.addEventListener("error", this.handleWsErrorEvent as EventListener);
		this.ws.addEventListener("close", this.handleWsCloseEvent as EventListener);
	}

	private removeWsListeners(): void {
		this.ws.removeEventListener("open", this.handleWsOpenEvent);
		this.ws.removeEventListener(
			"received",
			this.handleWsMessageEvent as EventListener,
		);
		this.ws.removeEventListener(
			"error",
			this.handleWsErrorEvent as EventListener,
		);
		this.ws.removeEventListener(
			"close",
			this.handleWsCloseEvent as EventListener,
		);
	}

	private setState(newState: typeof this.state, error?: Error): void {
		if (this.state !== newState) {
			this.state = newState;
			const payload: StateChangePayload = { state: newState, error };
			this.dispatchTypedEvent("state.change", payload);
		}
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
				const clientFinishStatic = this.noiseProcessor.processHandshake(
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
					this.noiseProcessor.encryptMessage(clientPayloadBytes);

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

				this.setState("authenticating");
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
		const allowedStates: ConnectionState[] = [
			"handshaking",
			"authenticating",
			"open",
		];

		if (!allowedStates.includes(this.state)) {
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

		try {
			const node = decodeBinaryNode(decryptedPayload);
			this.nodeHandler.processNode(node, this.state);
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			this.logger.error(
				{ err: error, data: bytesToHex(decryptedPayload) },
				"Failed to decode BinaryNode from decrypted frame",
			);
			this.dispatchTypedEvent("error", { error });
		}
	};

	async sendNode(node: BinaryNode): Promise<void> {
		if (this.state !== "open" && this.state !== "authenticating") {
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
		let error = this.closingError;

		if (this.state === "authenticating" && code === 1006) {
			error = new Error(
				"Connection closed, likely due to an expired client version.",
			);
		} else if (!error && this.state !== "closing") {
			error = new Error(`WebSocket closed unexpectedly: ${code} ${reason}`);
		}

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
		// Clear the closing error for the next connection cycle
		this.closingError = undefined;
	};

	async close(error?: Error): Promise<void> {
		if (this.state === "closing" || this.state === "closed") {
			return;
		}
		this.closingError = error;
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
