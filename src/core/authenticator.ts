import { EventEmitter } from "node:events";
import type { ConnectionManager } from "./connection";
import type {
  AuthenticationCreds,
  IAuthStateProvider,
} from "../state/interface";
import type { ILogger } from "../transport/types";
import {
  getBinaryNodeChild,
  getBinaryNodeChildren,
  S_WHATSAPP_NET,
  type BinaryNode,
} from "../binary";
import type { ClientPayload } from "../gen/whatsapp_pb";
import { bytesToBase64, bytesToUtf8, bytesToHex, equalBytes, concatBytes } from "../utils/bytes-utils";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ADVSignedDeviceIdentityHMACSchema,
  ADVSignedDeviceIdentitySchema,
  ADVDeviceIdentitySchema,
} from "../gen/whatsapp_pb";
import { hmacSign } from "../signal/crypto";
import { Curve } from "../signal/crypto";
import { generateLoginPayload, generateRegisterPayload } from "./auth-payload-generators";

interface AuthenticatorEvents {
  "connection.update": (
    update: Partial<{
      connection: "connecting" | "open" | "close";
      isNewLogin: boolean;
      qr?: string;
      error?: Error;
    }>,
  ) => void;
  "creds.update": (creds: Partial<AuthenticationCreds>) => void;

  "_internal.sendNode": (node: BinaryNode) => void;
  "_internal.closeConnection": (error?: Error) => void;
}

declare interface Authenticator {
  on<U extends keyof AuthenticatorEvents>(
    event: U,
    listener: AuthenticatorEvents[U],
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
  private processingPairSuccess = false;

  private initialQrTimeoutMs = 60_000;
  private subsequentQrTimeoutMs = 20_000;

  constructor(
    connectionManager: ConnectionManager,
    authStateProvider: IAuthStateProvider,
    logger: ILogger,
  ) {
    super();
    this.conn = connectionManager;
    this.authState = authStateProvider;
    this.logger = logger;

    this.conn.on("handshake.complete", this.handleHandshakeComplete);
    this.conn.on("node.received", this.handleNodeReceived);
    this.conn.on("error", (error) => {
      this.logger.error({ err: error }, "Connection error");
      this.clearQrTimeout();
      this.emit("connection.update", { connection: "close", error });
    });
    this.conn.on("ws.close", (_code, _reason) => {
      this.clearQrTimeout();
    });
  }

  private clearQrTimeout(): void {
    if (this.qrTimeout) {
      clearTimeout(this.qrTimeout);
      this.qrTimeout = undefined;
    }
  }

  public initiateAuthentication(): ClientPayload {
    this.logger.info("Authenticator initiating payload provision...");
    try {
      let payload: ClientPayload;
      if (this.authState.creds.registered && this.authState.creds.me?.id) {
        this.logger.info("Login flow: generating login payload early");
        payload = generateLoginPayload(this.authState.creds.me.id);
        return payload;
      } else {
        this.logger.info(
          "Registration flow: generating registration payload early",
        );
        payload = generateRegisterPayload(this.authState.creds);

        return payload;
      }
    } catch (error: any) {
      this.logger.error(
        { err: error },
        "Failed to prepare initial client payload",
      );
      this.emit("connection.update", { connection: "close", error });
      throw error;
    }
  }

  private handleHandshakeComplete = async (): Promise<void> => {
  };

  private handleNodeReceived = (node: BinaryNode): void => {
    this.logger.trace({ node }, "Received node");

    if (node.tag === "config") {
      if (
        getBinaryNodeChild(node, "pair-device")
      ) {
        this.handlePairDeviceIQ(node);
      } else if (
        getBinaryNodeChild(node, "pair-success")
      ) {
        this.handlePairSuccessIQ(node);
      }
    } else if (node.tag === "success") {
      this.handleLoginSuccess(node);
    } else if (node.tag === "failure") {
      this.handleLoginFailure(node);
    }
  };

  private handlePairDeviceIQ(node: BinaryNode): void {
    this.logger.info("Received pair-device IQ for QR code generation");
    this.processingPairSuccess = false;

    const pairDeviceNode = getBinaryNodeChild(node, "pair-device")!;
    const refNodes = getBinaryNodeChildren(pairDeviceNode, "ref");

    const ack: BinaryNode = {
      tag: "iq",
      attrs: {
        to: S_WHATSAPP_NET,
        type: "result",
      },
    };
    this.emit("_internal.sendNode", ack);

    this.qrRetryCount = 0;
    this.generateAndEmitQR(refNodes);
  }

  private generateAndEmitQR(refNodes: BinaryNode[]): void {
    this.clearQrTimeout();

    const refNode = refNodes[this.qrRetryCount];
    if (!refNode?.content) {
      this.logger.error(
        { refsAvailable: refNodes.length, count: this.qrRetryCount },
        "No more QR refs available, pairing timed out/failed",
      );
      const error = new Error("QR code generation failed (no refs left)");
      this.emit("connection.update", { connection: "close", error: error });
      this.emit("_internal.closeConnection", error);
      return;
    }

    const ref = bytesToUtf8(refNode.content as Uint8Array);
    const noiseKeyB64 = bytesToBase64(
      this.authState.creds.noiseKey.public,
    );
    const identityKeyB64 = bytesToBase64(
      this.authState.creds.signedIdentityKey.public,
    );
    const advSecretB64 = this.authState.creds.advSecretKey;

    const qr = [ref, noiseKeyB64, identityKeyB64, advSecretB64].join(",");
    this.logger.info(
      { qrCodeLength: qr.length, retry: this.qrRetryCount },
      "Generated QR Code",
    );
    this.emit("connection.update", { qr });

    const timeoutMs = this.qrRetryCount === 0
      ? this.initialQrTimeoutMs
      : this.subsequentQrTimeoutMs;
    this.qrTimeout = setTimeout(() => {
      this.qrRetryCount += 1;
      this.logger.info(
        `QR timeout, generating new QR (retry ${this.qrRetryCount})`,
      );
      this.generateAndEmitQR(refNodes);
    }, timeoutMs);
  }

  private _createSignalIdentity(
    jid: string,
    publicKey: Uint8Array,
  ): {
    identifier: { name: string; deviceId: number };
    identifierKey: Uint8Array;
  } {
    return {
      identifier: { name: jid, deviceId: 0 },
      identifierKey: publicKey,
    };
  }

  private _configureSuccessfulPairing(
    stanza: import("../binary").BinaryNode,
    creds: AuthenticationCreds,
  ): { creds: Partial<AuthenticationCreds>; reply: import("../binary").BinaryNode } {
    const msgId = stanza.attrs.id;
    if (!msgId) {
      throw new Error("Missing message ID in stanza for pair-success");
    }

    const pairSuccessNode = getBinaryNodeChild(stanza, "pair-success");
    if (!pairSuccessNode) throw new Error("Missing 'pair-success' in stanza");

    const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, "device-identity");
    const platformNode = getBinaryNodeChild(pairSuccessNode, "platform");
    const deviceNode = getBinaryNodeChild(pairSuccessNode, "device");
    const businessNode = getBinaryNodeChild(pairSuccessNode, "biz");

    if (!deviceIdentityNode?.content || !deviceNode?.attrs.jid) {
      throw new Error("Missing device-identity content or device jid in pair-success node");
    }

    const hmacIdentity = fromBinary(
      ADVSignedDeviceIdentityHMACSchema,
      deviceIdentityNode.content as Uint8Array,
    );
    if (!hmacIdentity.details || !hmacIdentity.hmac) {
      throw new Error("Invalid ADVSignedDeviceIdentityHMAC structure");
    }

    const advSign = hmacSign(hmacIdentity.details, creds.advSecretKey);

    if (!equalBytes(hmacIdentity.hmac, advSign)) {
      console.error("HMAC Details:", bytesToHex(hmacIdentity.details));
      console.error("ADV Key:", creds.advSecretKey);
      console.error("Received HMAC:", bytesToHex(hmacIdentity.hmac));
      console.error("Calculated HMAC:", bytesToHex(advSign));
      throw new Error("Invalid ADV account signature HMAC");
    }

    const account = fromBinary(ADVSignedDeviceIdentitySchema, hmacIdentity.details);
    if (!account.details || !account.accountSignatureKey || !account.accountSignature) {
      throw new Error("Invalid ADVSignedDeviceIdentity structure");
    }

    const accountMsg = concatBytes(
      new Uint8Array([6, 0]),
      account.details,
      creds.signedIdentityKey.public,
    );

    if (!Curve.verify(account.accountSignatureKey, accountMsg, account.accountSignature)) {
      throw new Error("Invalid account signature");
    }

    const deviceMsg = concatBytes(
      new Uint8Array([6, 1]),
      account.details,
      creds.signedIdentityKey.public,
      account.accountSignatureKey,
    );

    const deviceSignature = Curve.sign(creds.signedIdentityKey.private, deviceMsg);
    const updatedAccount = {
      ...account,
      deviceSignature,
    };

    const bizName = businessNode?.attrs.name;
    const jid = deviceNode.attrs.jid;
    const identity = this._createSignalIdentity(jid, account.accountSignatureKey);

    const authUpdate: Partial<AuthenticationCreds> = {
      me: { id: jid, name: bizName },
      account: updatedAccount,
      signalIdentities: [...(creds.signalIdentities || []), identity],
      platform: platformNode?.attrs.name,
      registered: true,
      pairingCode: undefined,
    };

    const encodeReplyAccount = (acc: typeof updatedAccount): Uint8Array => {
      const replyAcc = { ...acc, accountSignatureKey: undefined };
      return toBinary(ADVSignedDeviceIdentitySchema, replyAcc);
    };
    const accountEnc = encodeReplyAccount(updatedAccount);

    const deviceIdentity = fromBinary(ADVDeviceIdentitySchema, updatedAccount.details!);

    const reply = {
      tag: "iq",
      attrs: {
        to: S_WHATSAPP_NET,
        type: "result",
        id: msgId,
      },
      content: [
        {
          tag: "pair-device-sign",
          attrs: {},
          content: [
            {
              tag: "device-identity",
              attrs: { "key-index": (deviceIdentity.keyIndex || 0).toString() },
              content: accountEnc,
            },
          ],
        },
      ],
    };

    return { creds: authUpdate, reply };
  }

  private async handlePairSuccessIQ(node: BinaryNode): Promise<void> {
    if (this.processingPairSuccess) {
      this.logger.warn("Already processing pair-success, ignoring duplicate");
      return;
    }
    this.processingPairSuccess = true;
    this.logger.info("Received pair-success IQ");
    this.clearQrTimeout();

    try {
      const { creds: updatedCreds, reply } = this._configureSuccessfulPairing(
        node,
        this.authState.creds,
      );

      this.logger.info(
        {
          jid: updatedCreds.me?.id,
          platform: updatedCreds.platform,
        },
        "Pairing successful, updating creds",
      );

      Object.assign(this.authState.creds, updatedCreds);
      await this.authState.saveCreds();

      this.emit("_internal.sendNode", reply);
      this.logger.info("Sent pair-success confirmation reply");

      this.emit("creds.update", updatedCreds);
      this.emit("connection.update", { isNewLogin: true, qr: undefined });

      this.logger.info(
        "Pairing complete, expecting connection close and restart",
      );
    } catch (error: any) {
      this.logger.error({ err: error }, "Error processing pair-success IQ");
      this.emit("connection.update", { connection: "close", error });
      this.emit("_internal.closeConnection", error);
    } finally {
      this.processingPairSuccess = false;
    }
  }

  private handleLoginSuccess(node: BinaryNode): void {
    this.logger.info({ attrs: node.attrs }, "Login successful");
    this.clearQrTimeout();

    const platform = node.attrs.platform;
    const pushname = node.attrs.pushname;
    const updates: Partial<AuthenticationCreds> = {};
    if (platform && this.authState.creds.platform !== platform) {
      updates.platform = platform;
    }
    if (pushname && this.authState.creds.me?.name !== pushname) {
      updates.me = { ...this.authState.creds.me!, name: pushname };
    }
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

    this.emit("connection.update", { connection: "open" });
  }

  private handleLoginFailure(node: BinaryNode): void {
    const reason = node.attrs.reason || "unknown";
    const code = parseInt(reason, 10) || 401;
    this.logger.error({ code, attrs: node.attrs }, "Login failed");
    const error = new Error(`Login failed: ${reason}`);
    (error as any).code = code;

    this.clearQrTimeout();
    this.emit("connection.update", { connection: "close", error });
    this.emit("_internal.closeConnection", error);
  }
}

export { Authenticator };
export type { AuthenticatorEvents };
