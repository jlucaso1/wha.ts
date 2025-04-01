// src/core/authenticator.ts
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import type { ConnectionManager } from "./connection";
import type {
  AuthenticationCreds,
  IAuthStateProvider,
} from "../state/interface";
import type { ILogger } from "../transport/types";
import {
  generateLoginPayload,
  generateRegisterPayload,
  configureSuccessfulPairing,
} from "../utils/auth-logic";
import {
  getBinaryNodeChild,
  getBinaryNodeChildren,
  type BinaryNode,
  S_WHATSAPP_NET,
} from "../binary";
import { randomBytes } from "../signal/crypto"; // For ADV secret if needed
import type { ClientPayload } from "../gen/whatsapp_pb";

// Define events emitted by the Authenticator
interface AuthenticatorEvents {
  "connection.update": (
    update: Partial<{
      connection: "connecting" | "open" | "close"; // Add more states later
      isNewLogin: boolean;
      qr?: string;
      error?: Error;
    }>
  ) => void;
  "creds.update": (creds: Partial<AuthenticationCreds>) => void;
}

declare interface Authenticator {
  on<U extends keyof AuthenticatorEvents>(
    event: U,
    listener: AuthenticatorEvents[U]
  ): this;
  emit<U extends keyof AuthenticatorEvents>(
    event: U,
    ...args: Parameters<AuthenticatorEvents[U]>
  ): boolean;
}

class Authenticator extends EventEmitter {
  private conn: ConnectionManager;
  private authState: IAuthStateProvider;
  private logger: ILogger;
  private qrTimeout?: NodeJS.Timeout;
  private qrRetryCount = 0;
  private processingPairSuccess = false; // Prevent race conditions

  // Timer constants (could be configurable)
  private initialQrTimeoutMs = 60_000;
  private subsequentQrTimeoutMs = 20_000;

  constructor(
    connectionManager: ConnectionManager,
    authStateProvider: IAuthStateProvider,
    logger: ILogger
  ) {
    super();
    this.conn = connectionManager;
    this.authState = authStateProvider;
    this.logger = logger;

    // Listen to events from ConnectionManager
    this.conn.on("handshake.complete", this.handleHandshakeComplete);
    this.conn.on("node.received", this.handleNodeReceived);
    this.conn.on("error", (error) => {
      // Handle connection errors affecting authentication
      this.logger.error({ err: error }, "Connection error");
      this.clearQrTimeout();
      this.emit("connection.update", { connection: "close", error });
    });
    this.conn.on("ws.close", (code, reason) => {
      this.clearQrTimeout();
      // Don't emit 'close' if already emitted by 'error' handler
    });
  }

  private clearQrTimeout(): void {
    if (this.qrTimeout) {
      clearTimeout(this.qrTimeout);
      this.qrTimeout = undefined;
    }
  }

  // Called when Noise handshake is done
  private handleHandshakeComplete = async (): Promise<void> => {
    this.logger.info("Noise handshake complete, proceeding with WA auth");
    try {
      let payload: ClientPayload;
      if (this.authState.creds.registered && this.authState.creds.me?.id) {
        this.logger.info("Logging in with existing credentials");
        payload = generateLoginPayload(this.authState.creds.me.id); // Pass version/browser later
        // Login requires pull=true usually
      } else {
        this.logger.info("Registering new device");
        payload = generateRegisterPayload(this.authState.creds); // Pass version/browser later
        // Registration requires passive=true usually
      }
      // Tell ConnectionManager to send this payload during ClientFinish
      // Assuming conn.provideClientPayload exists (needs implementation in ConnectionManager)
      await this.conn.provideClientPayload(payload); // This needs to be awaited in conn
    } catch (error: any) {
      this.logger.error({ err: error }, "Failed to prepare client payload");
      this.conn.close(error); // Close connection if payload generation fails
    }
  };

  // Called when a decoded BinaryNode is received after handshake
  private handleNodeReceived = (node: BinaryNode): void => {
    this.logger.trace({ tag: node.tag, attrs: node.attrs }, "Received node");

    if (node.tag === "iq") {
      // --- Pairing ---
      if (
        node.attrs.type === "set" &&
        getBinaryNodeChild(node, "pair-device")
      ) {
        this.handlePairDeviceIQ(node);
      } else if (
        node.attrs.type === "result" &&
        getBinaryNodeChild(node, "pair-success")
      ) {
        this.handlePairSuccessIQ(node);
      }
      // --- Login Response ---
      // Note: These are outside the <iq> tag in the original Baileys listener structure
      // They are top-level stanzas after successful authentication.
      // We might need a separate listener or adjust ConnectionManager's node emission.
      // For now, keeping the logic here for simplicity.
    } else if (node.tag === "success") {
      this.handleLoginSuccess(node);
    } else if (node.tag === "failure") {
      this.handleLoginFailure(node);
    }
    // TODO: Handle <stream:error>, <xmlstreamend> etc. (Likely in ConnectionManager close handler)
  };

  // --- Specific Node Handlers ---

  private handlePairDeviceIQ(node: BinaryNode): void {
    this.logger.info("Received pair-device IQ for QR code generation");
    this.processingPairSuccess = false; // Reset flag if we get a new QR request

    const pairDeviceNode = getBinaryNodeChild(node, "pair-device")!;
    const refNodes = getBinaryNodeChildren(pairDeviceNode, "ref");

    if (!node.attrs.id) {
      this.logger.error("Pair-device IQ missing ID attribute");
      return;
    }

    // Send receipt ack for the IQ
    const ack: BinaryNode = {
      tag: "iq",
      attrs: {
        to: S_WHATSAPP_NET,
        type: "result",
        id: node.attrs.id,
      },
    };
    this.conn
      .sendNode(ack)
      .catch((err) =>
        this.logger.warn({ err }, "Failed to send pair-device IQ ack")
      );

    this.qrRetryCount = 0; // Reset retry count for new pairing attempt
    this.generateAndEmitQR(refNodes);
  }

  private generateAndEmitQR(refNodes: BinaryNode[]): void {
    this.clearQrTimeout(); // Clear any previous timer

    const refNode = refNodes[this.qrRetryCount];
    if (!refNode?.content) {
      this.logger.error(
        { refsAvailable: refNodes.length, count: this.qrRetryCount },
        "No more QR refs available, pairing timed out/failed"
      );
      const error = new Error("QR code generation failed (no refs left)");
      this.emit("connection.update", { connection: "close", error: error });
      this.conn.close(error); // Close connection
      return;
    }

    const ref = Buffer.from(refNode.content as Uint8Array).toString("utf-8");
    const noiseKeyB64 = Buffer.from(
      this.authState.creds.noiseKey.public
    ).toString("base64");
    const identityKeyB64 = Buffer.from(
      this.authState.creds.signedIdentityKey.public
    ).toString("base64");
    const advSecretB64 = this.authState.creds.advSecretKey;

    const qr = [ref, noiseKeyB64, identityKeyB64, advSecretB64].join(",");
    this.logger.info(
      { qrCodeLength: qr.length, retry: this.qrRetryCount },
      "Generated QR Code"
    );
    this.emit("connection.update", { qr });

    // Set timeout for the next QR code
    const timeoutMs =
      this.qrRetryCount === 0
        ? this.initialQrTimeoutMs
        : this.subsequentQrTimeoutMs;
    this.qrTimeout = setTimeout(() => {
      this.qrRetryCount += 1;
      this.logger.info(
        `QR timeout, generating new QR (retry ${this.qrRetryCount})`
      );
      this.generateAndEmitQR(refNodes);
    }, timeoutMs);
  }

  private async handlePairSuccessIQ(node: BinaryNode): Promise<void> {
    if (this.processingPairSuccess) {
      this.logger.warn("Already processing pair-success, ignoring duplicate");
      return;
    }
    this.processingPairSuccess = true;
    this.logger.info("Received pair-success IQ");
    this.clearQrTimeout(); // Pairing successful, stop QR timer

    try {
      const { creds: updatedCreds, reply } = configureSuccessfulPairing(
        node,
        this.authState.creds
      );

      this.logger.info(
        {
          jid: updatedCreds.me?.id,
          platform: updatedCreds.platform,
        },
        "Pairing successful, updating creds"
      );

      // Update state provider
      Object.assign(this.authState.creds, updatedCreds);
      await this.authState.saveCreds();

      // Send reply IQ via connection manager
      await this.conn.sendNode(reply);
      this.logger.info("Sent pair-success confirmation reply");

      // Emit events
      this.emit("creds.update", updatedCreds); // Emit only the changes
      this.emit("connection.update", { isNewLogin: true, qr: undefined });

      // WA often closes the connection after pair-success to restart
      this.logger.info(
        "Pairing complete, expecting connection close and restart"
      );
      // We don't explicitly close here, wait for server to do it or timeout
    } catch (error: any) {
      this.logger.error({ err: error }, "Error processing pair-success IQ");
      this.emit("connection.update", { connection: "close", error });
      this.conn.close(error); // Close connection on error
    } finally {
      this.processingPairSuccess = false;
    }
  }

  private handleLoginSuccess(node: BinaryNode): void {
    this.logger.info({ attrs: node.attrs }, "Login successful");
    this.clearQrTimeout(); // Should be cleared already, but just in case

    // Update creds if needed (e.g., platform, pushname from server)
    const platform = node.attrs.platform;
    const pushname = node.attrs.pushname; // Check exact attribute name
    const updates: Partial<AuthenticationCreds> = {};
    if (platform && this.authState.creds.platform !== platform) {
      updates.platform = platform;
    }
    if (pushname && this.authState.creds.me?.name !== pushname) {
      updates.me = { ...this.authState.creds.me!, name: pushname };
    }
    // Maybe update 'registered' flag here too if not already set
    if (!this.authState.creds.registered) {
      updates.registered = true;
    }

    if (Object.keys(updates).length > 0) {
      this.logger.info({ updates }, "Updating creds after login success");
      Object.assign(this.authState.creds, updates);
      this.authState
        .saveCreds()
        .then(() => this.emit("creds.update", updates))
        .catch((err) =>
          this.logger.error({ err }, "Failed to save creds after login")
        );
    }

    // Emit final connection open state
    this.emit("connection.update", { connection: "open" });
  }

  private handleLoginFailure(node: BinaryNode): void {
    const reason = node.attrs.reason || "unknown";
    const code = parseInt(reason, 10) || 401; // Default to 401 (Not Authorized)
    this.logger.error({ code, attrs: node.attrs }, "Login failed");
    const error = new Error(`Login failed: ${reason}`);
    (error as any).code = code; // Add code for potential handling

    this.clearQrTimeout();
    this.emit("connection.update", { connection: "close", error });
    this.conn.close(error); // Close connection on failure
  }
}

export { Authenticator };
export type { AuthenticatorEvents };
