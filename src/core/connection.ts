import { EventEmitter } from "events";
import { Buffer } from "buffer";
import { NativeWebSocketClient } from "../transport/websocket";
import { NoiseHandler } from "../transport/noise-handler";
import { decodeBinaryNode, encodeBinaryNode, type BinaryNode } from "../binary";
import type { WebSocketConfig, ILogger } from "../transport/types";
import { DEFAULT_SOCKET_CONFIG } from "../defaults";
import { S_WHATSAPP_NET } from "../binary/jid-utils";
import { fromBinary } from "@bufbuild/protobuf";
import { HandshakeMessageSchema, type ClientPayload } from "../gen/whatsapp_pb";
import type { KeyPair } from "../state/interface";

interface ConnectionManagerEvents {
  "state.change": (
    state: "connecting" | "open" | "handshaking" | "closing" | "closed",
    error?: Error
  ) => void;
  "handshake.complete": () => void;
  "node.received": (node: BinaryNode) => void;
  "node.sent": (node: BinaryNode) => void;
  error: (error: Error) => void;
  "ws.close": (code: number, reason: string) => void;
}

declare interface ConnectionManager {
  on<U extends keyof ConnectionManagerEvents>(
    event: U,
    listener: ConnectionManagerEvents[U]
  ): this;
  emit<U extends keyof ConnectionManagerEvents>(
    event: U,
    ...args: Parameters<ConnectionManagerEvents[U]>
  ): boolean;
}

class ConnectionManager extends EventEmitter {
  // ... (Keep existing properties: ws, noise, logger, config, state, keepAliveInterval, lastReceivedDataTime)
  private ws: NativeWebSocketClient;
  private noise: NoiseHandler;
  private logger: ILogger;
  private config: WebSocketConfig; // Store relevant config
  private state: "connecting" | "open" | "handshaking" | "closing" | "closed" =
    "closed";
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private lastReceivedDataTime: number = 0;
  private staticKeyPair: KeyPair;
  private routingInfo?: Buffer;

  // NEW: Promise to wait for client payload from Authenticator
  private clientPayloadPromise: Promise<ClientPayload> | null = null;
  private resolveClientPayload: ((payload: ClientPayload) => void) | null =
    null;

  constructor(
    wsConfig: Partial<WebSocketConfig>,
    staticKeyPair: KeyPair,
    logger: ILogger,
    routingInfo?: Buffer
  ) {
    super();
    this.setMaxListeners(0);
    this.logger = logger;
    this.config = { ...DEFAULT_SOCKET_CONFIG, ...wsConfig } as WebSocketConfig;
    this.staticKeyPair = staticKeyPair; // Store static keys
    this.routingInfo = routingInfo; // Store routing info

    this.ws = new NativeWebSocketClient(this.config.url, this.config);
    this.noise = new NoiseHandler(staticKeyPair, this.logger, this.routingInfo);

    this.setupWsListeners();
  }

  // ... (keep setState, setupWsListeners, removeWsListeners)
  private setState(newState: typeof this.state, error?: Error): void {
    if (this.state !== newState) {
      this.logger.info(
        { from: this.state, to: newState, err: error?.message },
        "Connection state changed"
      );
      this.state = newState;
      this.emit("state.change", newState, error);
    }
  }

  private setupWsListeners(): void {
    this.ws.on("open", this.handleWsOpen);
    this.ws.on("message", this.handleWsMessage);
    this.ws.on("error", this.handleWsError);
    this.ws.on("close", this.handleWsClose);
  }

  private removeWsListeners(): void {
    this.ws.off("open", this.handleWsOpen);
    this.ws.off("message", this.handleWsMessage);
    this.ws.off("error", this.handleWsError);
    this.ws.off("close", this.handleWsClose);
  }

  // --- Connection Lifecycle ---
  async connect(): Promise<void> {
    if (this.state !== "closed") {
      this.logger.warn(
        { state: this.state },
        "Connect called on non-closed connection"
      );
      return; // Or throw error?
    }
    this.setState("connecting");
    try {
      // Reset noise state for new connection attempt
      this.noise = new NoiseHandler(
        this.staticKeyPair,
        this.logger,
        this.routingInfo
      );
      // Reset client payload promise
      this.clientPayloadPromise = new Promise((resolve) => {
        this.resolveClientPayload = resolve;
      });
      await this.ws.connect();
      // ws 'open' event will trigger handleWsOpen and start handshake
    } catch (error: any) {
      this.logger.error({ err: error }, "WebSocket connection failed");
      this.setState("closed", error);
      this.emit("error", error); // Emit specific connection error
      throw error; // Re-throw for the caller
    }
  }

  // --- Handshake Logic ---

  // NEW: Method for Authenticator to provide the payload
  public provideClientPayload(payload: ClientPayload): void {
    if (!this.resolveClientPayload) {
      this.logger.error("Attempted to provide ClientPayload outside handshake");
      // Optionally throw an error or just log
      return;
    }
    this.logger.info("Received ClientPayload from Authenticator");
    this.resolveClientPayload(payload);
    this.resolveClientPayload = null; // Consume the resolver
  }

  private handleWsOpen = async (): Promise<void> => {
    // ... (rest of the function is the same)
    this.logger.info("WebSocket opened, starting Noise handshake");
    this.setState("handshaking");
    this.lastReceivedDataTime = Date.now(); // Start keep-alive timer base

    try {
      const handshakeMsg = await this.noise.generateInitialHandshakeMessage();

      const initialFrame = this.noise.encodeFrame(handshakeMsg);
      await this.ws.send(initialFrame);
      this.logger.info("Sent ClientHello");
      // Now wait for ServerHello via handleWsMessage -> handleHandshakeData
    } catch (error: any) {
      this.logger.error({ err: error }, "Noise handshake initiation failed");
      this.close(error); // Close connection on handshake error
    }
  };

  private handleHandshakeData = async (data: Uint8Array): Promise<void> => {
    try {
      // Need to decode HandshakeMessage here now
      // Assuming HandshakeMessageSchema exists from generation
      const handshakeMsg = fromBinary(HandshakeMessageSchema, data);

      if (handshakeMsg.serverHello) {
        this.logger.info("Received ServerHello");
        await this.noise.processServerHello(handshakeMsg);
        this.logger.info("Processed ServerHello");

        // --- Wait for Client Payload ---
        if (!this.clientPayloadPromise) {
          throw new Error("ClientPayload promise not initialized!");
        }
        this.logger.info("Waiting for ClientPayload from Authenticator...");
        const clientPayload = await this.clientPayloadPromise;
        this.logger.info("Got ClientPayload, generating ClientFinish");
        // --- End Wait ---

        const clientFinishBytes = await this.noise.generateClientFinish(
          clientPayload
        );
        const finalFrame = this.noise.encodeFrame(clientFinishBytes);
        await this.ws.send(finalFrame);
        this.logger.info("Sent ClientFinish");

        // Handshake is logically complete from Noise perspective
        this.noise.finishHandshake();
        this.setState("open"); // Transition state *after* sending ClientFinish
        this.startKeepAlive(); // Start keep-alive mechanism
        this.emit("handshake.complete"); // Notify listeners (like Authenticator)
      } else {
        throw new Error("Received unexpected message during handshake");
      }
    } catch (error: any) {
      this.logger.error({ err: error }, "Noise handshake processing failed");
      this.close(error);
    }
  };

  // --- Data Handling ---
  private handleWsMessage = (data: Buffer): void => {
    this.lastReceivedDataTime = Date.now(); // Update keep-alive timer
    try {
      // Pass raw data to Noise decoder, provide callback
      this.noise.decodeFrame(data, this.handleDecryptedFrame);
    } catch (error: any) {
      this.logger.error(
        { dataLength: data.length, err: error },
        "Noise frame decoding/decryption failed"
      );
      this.emit("error", error); // Emit raw decryption error
      // Consider closing connection on persistent decryption errors?
      // this.close(new Error("Decryption failed"));
    }
  };

  // ... (Keep handleDecryptedFrame, sendNode, start/stopKeepAlive, handleWsError, handleWsClose)
  // Callback provided to noise.decodeFrame
  private handleDecryptedFrame = (decryptedPayload: Uint8Array): void => {
    if (this.state !== "open" && this.state !== "handshaking") {
      this.logger.warn(
        { state: this.state },
        "Received data in unexpected state, ignoring"
      );
      return;
    }
    this.logger.trace(
      { length: decryptedPayload.length, state: this.state },
      "Decrypted frame received"
    );
    // If still handshaking, pass data to handshake handler
    if (this.state === "handshaking") {
      // this need to be true before the first data from server
      this.handleHandshakeData(decryptedPayload).catch((err) => {
        this.logger.error({ err }, "Error in async handshake data handler");
        this.close(err);
      });
      return;
    }

    // If handshake complete (state === 'open'), decode as BinaryNode
    try {
      const node = decodeBinaryNode(decryptedPayload);
      this.logger.trace(
        { tag: node.tag, attrs: node.attrs },
        "Decoded BinaryNode"
      );
      this.emit("node.received", node); // Emit the decoded node
    } catch (error: any) {
      this.logger.error(
        { err: error, hex: Buffer.from(decryptedPayload).toString("hex") },
        "Failed to decode BinaryNode from decrypted frame"
      );
      this.emit("error", error); // Emit decoding error
    }
  };

  // --- Sending ---

  async sendNode(node: BinaryNode): Promise<void> {
    if (this.state !== "open") {
      // Maybe queue or throw error? Baileys likely throws.
      throw new Error(
        `Cannot send node while connection state is "${this.state}"`
      );
    }
    this.logger.trace(
      { tag: node.tag, attrs: node.attrs },
      "Encoding and sending node"
    );
    try {
      const buffer = encodeBinaryNode(node);
      const frame = this.noise.encodeFrame(buffer);
      await this.ws.send(frame);
      this.emit("node.sent", node); // Emit after successful WS send
    } catch (error: any) {
      this.logger.error({ err: error, tag: node.tag }, "Failed to send node");
      // Decide if this error requires closing the connection
      // this.close(error);
      throw error; // Re-throw for caller
    }
  }

  // --- Keep Alive ---

  private startKeepAlive(): void {
    this.stopKeepAlive(); // Clear any existing interval

    this.keepAliveInterval = setInterval(() => {
      if (this.state !== "open") {
        this.logger.warn("Keep-alive running in non-open state, stopping.");
        this.stopKeepAlive();
        return;
      }

      const timeSinceLastReceive = Date.now() - this.lastReceivedDataTime;
      if (
        timeSinceLastReceive >
        (this.config.keepAliveIntervalMs || 30000) + 5000
      ) {
        // Add buffer
        this.logger.warn(
          `No data received in ${timeSinceLastReceive}ms, closing connection.`
        );
        this.close(new Error("Connection timed out (keep-alive)"));
      } else {
        // Send keep-alive ping (standard IQ stanza)
        this.sendNode({
          tag: "iq",
          attrs: {
            id: `ping_${Date.now()}`,
            to: S_WHATSAPP_NET,
            type: "get",
            xmlns: "w:p",
          }, // Ensure unique ID
          content: [{ tag: "ping", attrs: {} }],
        }).catch((err) => {
          // Log error but don't necessarily close connection immediately
          this.logger.warn({ err }, "Keep-alive ping send failed");
        });
      }
    }, this.config.keepAliveIntervalMs);

    this.logger.info(
      `Started keep-alive interval: ${this.config.keepAliveIntervalMs}ms`
    );
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      this.logger.info("Stopped keep-alive interval");
    }
  }

  // --- Error and Close Handling ---

  private handleWsError = (error: Error): void => {
    this.logger.error({ err: error }, "WebSocket error occurred");
    this.emit("error", error);
    // WS 'error' is often followed by 'close', so handle state in 'close'
    // If not, we might need to force close here:
    this.close(error);
  };

  private handleWsClose = (code: number, reasonBuffer: Buffer): void => {
    const reason = reasonBuffer.toString();
    this.logger.warn({ code, reason }, "WebSocket connection closed");
    const error =
      this.state !== "closing"
        ? new Error(`WebSocket closed unexpectedly: ${code} ${reason}`)
        : undefined; // Use stored error if closing intentionally
    this.setState(
      "closed",
      error ||
        (this.state === "closing"
          ? undefined
          : new Error("Unknown close reason"))
    ); // Ensure state is closed
    this.stopKeepAlive(); // Ensure keep-alive is stopped
    this.removeWsListeners(); // Clean up listeners
    this.emit("ws.close", code, reason); // Emit raw close event
    if (error) this.emit("error", error); // Emit error if unexpected close
  };

  // Make close accessible
  async close(error?: Error): Promise<void> {
    if (this.state === "closing" || this.state === "closed") {
      return;
    }
    this.setState("closing", error);
    this.stopKeepAlive();
    try {
      // 1000 = Normal closure, 1011 = Internal Error
      await this.ws.close(
        error ? 1011 : 1000,
        error?.message || "User initiated close"
      );
    } catch (wsError: any) {
      this.logger.warn({ err: wsError }, "Error during WebSocket close");
      // Force state to closed even if WS close fails
      this.handleWsClose(
        wsError.code || 1011,
        wsError.message || "Forced close after error"
      );
    }
  }
}

export { ConnectionManager };
export type { ConnectionManagerEvents }; // Export events if needed externally
