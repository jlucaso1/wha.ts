import { NativeWebSocketClient } from "../transport/websocket";
import { type BinaryNode, decodeBinaryNode, encodeBinaryNode } from "../binary";
import type { ILogger, WebSocketConfig } from "../transport/types";
import { DEFAULT_SOCKET_CONFIG, NOISE_WA_HEADER } from "../defaults";
import { S_WHATSAPP_NET } from "../binary/jid-utils";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  type ClientPayload,
  ClientPayloadSchema,
  HandshakeMessageSchema,
} from "../gen/whatsapp_pb";
import type { AuthenticationCreds } from "../state/interface";
import { NoiseProcessor } from "../transport/noise-processor";
import { FrameHandler } from '../transport/frame-handler';
import {
  generateLoginPayload,
  generateRegisterPayload,
} from "./auth-payload-generators";
import { bytesToHex } from "../utils/bytes-utils";
import { TypedEventTarget } from "../utils/typed-event-target";
import {
  type ConnectionManagerEventMap,
  type StateChangePayload,
  // type ErrorPayload,
  // type NodeReceivedPayload,
  // type NodeSentPayload,
  // type WsClosePayload
} from "./connection-events";

class ConnectionManager extends TypedEventTarget<ConnectionManagerEventMap> {
  private ws: NativeWebSocketClient;
  private logger: ILogger;
  private config: WebSocketConfig;
  private state: "connecting" | "open" | "handshaking" | "closing" | "closed" =
    "closed";
  private keepAliveInterval?: ReturnType<typeof setInterval>;
  private lastReceivedDataTime: number = 0;
  private routingInfo?: Uint8Array;
  private creds: AuthenticationCreds;

  private noiseProcessor: NoiseProcessor;
  private frameHandler: FrameHandler;

  constructor(
    wsConfig: Partial<WebSocketConfig>,
    logger: ILogger,
    creds: AuthenticationCreds
  ) {
    super();
    this.logger = logger;
    this.config = { ...DEFAULT_SOCKET_CONFIG, ...wsConfig } as WebSocketConfig;
    this.creds = creds;
    this.routingInfo = creds.routingInfo;

    this.noiseProcessor = new NoiseProcessor({
      localStaticKeyPair: creds.pairingEphemeralKeyPair,
      noisePrologue: NOISE_WA_HEADER,
      logger: this.logger,
      routingInfo: this.routingInfo,
    });

    this.frameHandler = new FrameHandler(
      this.noiseProcessor,
      this.logger,
      this.handleDecryptedFrame,
      this.routingInfo,
      NOISE_WA_HEADER
    );

    this.ws = new NativeWebSocketClient(this.config.url, this.config);

    this.setupWsListeners();
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
        "Connect called on non-closed connection"
      );
      return;
    }
    this.setState("connecting");
    try {
      await this.ws.connect();
    } catch (error: any) {
      this.logger.error({ err: error }, "WebSocket connection failed");
      this.setState("closed", error);
      this.dispatchTypedEvent("error", { error });
      throw error;
    }
  }

  private handleWsOpen = async (): Promise<void> => {
    this.setState("handshaking");
    this.lastReceivedDataTime = Date.now();

    try {
      const handshakeMsg = this.noiseProcessor.generateInitialHandshakeMessage(
        this.creds.pairingEphemeralKeyPair
      );

      const frame = await this.frameHandler.framePayload(handshakeMsg);
      await this.ws.send(frame);
    } catch (error: any) {
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
          this.creds.pairingEphemeralKeyPair
        );
        let clientPayload: ClientPayload;
        if (this.creds.registered && this.creds.me?.id) {
          clientPayload = generateLoginPayload(this.creds.me.id);
        } else {
          clientPayload = generateRegisterPayload(this.creds);
        }

        const clientPayloadBytes = toBinary(ClientPayloadSchema, clientPayload);

        const payloadEnc = await this.noiseProcessor.encryptMessage(
          clientPayloadBytes
        );

        const clientFinishMsg = create(HandshakeMessageSchema, {
          clientFinish: {
            static: clientFinishStatic,
            payload: payloadEnc,
          },
        });

        const finishPayloadBytes = toBinary(
          HandshakeMessageSchema,
          clientFinishMsg
        );

        const frame = await this.frameHandler.framePayload(finishPayloadBytes);
        await this.ws.send(frame);

        this.noiseProcessor.finalizeHandshake();

        this.setState("open");
        this.dispatchTypedEvent("handshake.complete", {});
      } else {
        throw new Error("Received unexpected message during handshake");
      }
    } catch (error: any) {
      this.logger.error({ err: error }, "Noise handshake processing failed");
      this.close(error);
    }
  };

  private handleWsMessage = async (data: Uint8Array): Promise<void> => {
    this.lastReceivedDataTime = Date.now();
    try {
      await this.frameHandler.handleReceivedData(data);
    } catch (error: any) {
      this.logger.error(
        { dataLength: data.length, err: error },
        "Noise frame decoding/decryption failed"
      );
      this.dispatchTypedEvent("error", { error });
    }
  };

  private handleDecryptedFrame = async (
    decryptedPayload: Uint8Array
  ): Promise<void> => {
    if (this.state !== "open" && this.state !== "handshaking") {
      this.logger.warn(
        { state: this.state },
        "Received data in unexpected state, ignoring"
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
      const node = await decodeBinaryNode(decryptedPayload);

      this.dispatchTypedEvent("node.received", { node });
    } catch (error: any) {
      this.logger.error(
        { err: error, hex: bytesToHex(decryptedPayload) },
        "Failed to decode BinaryNode from decrypted frame"
      );
      this.dispatchTypedEvent("error", { error });
    }
  };

  async sendNode(node: BinaryNode): Promise<void> {
    if (this.state !== "open") {
      throw new Error(
        `Cannot send node while connection state is "${this.state}"`
      );
    }

    try {
      const buffer = encodeBinaryNode(node);
      const frame = await this.frameHandler.framePayload(buffer);
      await this.ws.send(frame);
      this.dispatchTypedEvent("node.sent", { node });
    } catch (error: any) {
      this.logger.error({ err: error, tag: node.tag }, "Failed to send node");
      throw error;
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();

    this.keepAliveInterval = setInterval(() => {
      if (this.state !== "open") {
        this.stopKeepAlive();
        return;
      }

      const timeSinceLastReceive = Date.now() - this.lastReceivedDataTime;
      if (
        timeSinceLastReceive >
        (this.config.keepAliveIntervalMs || 30000) + 5000
      ) {
        this.logger.warn(
          `No data received in ${timeSinceLastReceive}ms, closing connection.`
        );
        this.close(new Error("Connection timed out (keep-alive)"));
      } else {
        this.sendNode({
          tag: "iq",
          attrs: {
            id: `ping_${Date.now()}`,
            to: S_WHATSAPP_NET,
            type: "get",
            xmlns: "w:p",
          },
          content: [{ tag: "ping", attrs: {} }],
        }).catch((err) => {
          this.logger.warn({ err }, "Keep-alive ping send failed");
        });
      }
    }, this.config.keepAliveIntervalMs);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = undefined;
      this.logger.info("Stopped keep-alive interval");
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
          : new Error("Unknown close reason"))
    );
    this.stopKeepAlive();
    this.removeWsListeners();
    this.dispatchTypedEvent("ws.close", { code, reason });
    if (error) this.dispatchTypedEvent("error", { error });
  };

  async close(error?: Error): Promise<void> {
    if (this.state === "closing" || this.state === "closed") {
      return;
    }
    this.setState("closing", error);
    this.stopKeepAlive();
    try {
      const closeCode = 1000;
      const closeReason = error?.message || "User initiated close";

      await this.ws.close(closeCode, closeReason);
    } catch (wsError: any) {
      this.logger.error(
        { err: wsError },
        "Error explicitly closing WebSocket in ConnectionManager"
      );
      this.handleWsClose(
        wsError.code || 1011,
        wsError.message || "Forced close after error"
      );
    }
  }
}

export { ConnectionManager };
