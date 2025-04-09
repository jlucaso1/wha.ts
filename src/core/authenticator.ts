import type { ConnectionManager } from "./connection";
import type {
  AuthenticationCreds,
  IAuthStateProvider,
} from "../state/interface";
import type { ILogger } from "../transport/types";
import {
  type BinaryNode,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  S_WHATSAPP_NET,
  type SINGLE_BYTE_TOKENS_TYPE,
} from "../binary";
import type { ClientPayload } from "../gen/whatsapp_pb";
import {
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  equalBytes,
} from "../utils/bytes-utils";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ADVDeviceIdentitySchema,
  ADVSignedDeviceIdentityHMACSchema,
  ADVSignedDeviceIdentitySchema,
} from "../gen/whatsapp_pb";
import { hmacSign } from "../signal/crypto";
import { Curve } from "../signal/crypto";
import {
  generateLoginPayload,
  generateRegisterPayload,
} from "./auth-payload-generators";

interface AuthenticatorEvents {
  "connection.update": (
    update: Partial<{
      connection: "connecting" | "open" | "close";
      isNewLogin: boolean;
      qr?: string;
      error?: Error;
    }>
  ) => void;
  "creds.update": (creds: Partial<AuthenticationCreds>) => void;

  "_internal.sendNode": (node: BinaryNode) => void;
  "_internal.closeConnection": (error?: Error) => void;
}

class Authenticator extends EventTarget {
  private conn: ConnectionManager;
  private authState: IAuthStateProvider;
  private logger: ILogger;
  private qrTimeout?: ReturnType<typeof setTimeout>;
  private qrRetryCount = 0;
  private processingPairSuccess = false;

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

    this.conn.addEventListener(
      "handshake.complete",
      this.handleHandshakeComplete
    );

    this.conn.addEventListener("node.received", ((event: Event) => {
      if (event instanceof CustomEvent) {
        this.handleNodeReceived(event.detail);
      }
    }) as EventListener);

    this.conn.addEventListener("error", ((event: Event) => {
      if (event instanceof CustomEvent) {
        const error = event.detail;
        this.logger.error({ err: error }, "Connection error");
        this.clearQrTimeout();
        this.dispatchEvent(
          new CustomEvent("connection.update", {
            detail: { connection: "close", error },
          })
        );
      }
    }) as EventListener);

    this.conn.addEventListener("ws.close", (_event) => {
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
    try {
      let payload: ClientPayload;
      if (this.authState.creds.registered && this.authState.creds.me?.id) {
        payload = generateLoginPayload(this.authState.creds.me.id);
        return payload;
      } else {
        payload = generateRegisterPayload(this.authState.creds);

        return payload;
      }
    } catch (error: any) {
      this.logger.error(
        { err: error },
        "Failed to prepare initial client payload"
      );
      this.dispatchEvent(
        new CustomEvent("connection.update", {
          detail: { connection: "close", error },
        })
      );
      throw error;
    }
  }

  private handleHandshakeComplete = async (): Promise<void> => {};

  private handleNodeReceived = (node: BinaryNode): void => {
    if (node.tag === "iq") {
      if (getBinaryNodeChild(node, "pair-device")) {
        this.handlePairDeviceIQ(node);
      } else if (getBinaryNodeChild(node, "pair-success")) {
        this.handlePairSuccessIQ(node);
      }
    } else if (node.tag === "success") {
      this.handleLoginSuccess(node);
    } else if (node.tag === "fail") {
      this.handleLoginFailure(node);
    }
  };

  private handlePairDeviceIQ(node: BinaryNode): void {
    this.processingPairSuccess = false;

    const pairDeviceNode = getBinaryNodeChild(node, "pair-device")!;
    const refNodes = getBinaryNodeChildren(pairDeviceNode, "ref");

    this.qrRetryCount = 0;
    this.generateAndEmitQR(refNodes);

    if (!node.attrs.id) {
      throw new Error("Missing message ID in stanza for pair-device");
    }

    const ack: BinaryNode = {
      tag: "iq",
      attrs: {
        to: S_WHATSAPP_NET,
        type: "result",
        id: node.attrs.id,
      },
    };

    this.dispatchEvent(new CustomEvent("_internal.sendNode", { detail: ack }));
  }

  private generateAndEmitQR(refNodes: BinaryNode[]): void {
    this.clearQrTimeout();

    const refNode = refNodes[this.qrRetryCount];
    if (!refNode?.content) {
      this.logger.error(
        { refsAvailable: refNodes.length, count: this.qrRetryCount },
        "No more QR refs available, pairing timed out/failed"
      );
      const error = new Error("QR code generation failed (no refs left)");
      this.dispatchEvent(
        new CustomEvent("connection.update", {
          detail: { connection: "close", error },
        })
      );
      this.dispatchEvent(
        new CustomEvent("_internal.closeConnection", { detail: error })
      );
      return;
    }

    if (!(refNode.content instanceof Uint8Array)) {
      throw new Error("Invalid reference node content");
    }

    const ref = bytesToUtf8(refNode.content);
    const noiseKeyB64 = bytesToBase64(this.authState.creds.noiseKey.public);
    const identityKeyB64 = bytesToBase64(
      this.authState.creds.signedIdentityKey.public
    );
    const advSecretB64 = this.authState.creds.advSecretKey;

    const qr = [ref, noiseKeyB64, identityKeyB64, advSecretB64].join(",");

    this.dispatchEvent(
      new CustomEvent("connection.update", { detail: { qr } })
    );

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

  private _createSignalIdentity(
    jid: string,
    publicKey: Uint8Array
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
    creds: AuthenticationCreds
  ): {
    creds: Partial<AuthenticationCreds>;
    reply: import("../binary").BinaryNode;
  } {
    const msgId = stanza.attrs.id;
    if (!msgId) {
      throw new Error("Missing message ID in stanza for pair-success");
    }

    const pairSuccessNode = getBinaryNodeChild(stanza, "pair-success");
    if (!pairSuccessNode) throw new Error("Missing 'pair-success' in stanza");

    const deviceIdentityNode = getBinaryNodeChild(
      pairSuccessNode,
      "device-identity"
    );
    const platformNode = getBinaryNodeChild(pairSuccessNode, "platform");
    const deviceNode = getBinaryNodeChild(pairSuccessNode, "device");
    const businessNode = getBinaryNodeChild(pairSuccessNode, "biz");

    if (!deviceIdentityNode?.content || !deviceNode?.attrs.jid) {
      throw new Error(
        "Missing device-identity content or device jid in pair-success node"
      );
    }

    const hmacIdentity = fromBinary(
      ADVSignedDeviceIdentityHMACSchema,
      deviceIdentityNode.content as Uint8Array
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

    const account = fromBinary(
      ADVSignedDeviceIdentitySchema,
      hmacIdentity.details
    );
    if (
      !account.details ||
      !account.accountSignatureKey ||
      !account.accountSignature
    ) {
      throw new Error("Invalid ADVSignedDeviceIdentity structure");
    }

    const accountMsg = concatBytes(
      new Uint8Array([6, 0]),
      account.details,
      creds.signedIdentityKey.public
    );

    if (
      !Curve.verify(
        account.accountSignatureKey,
        accountMsg,
        account.accountSignature
      )
    ) {
      throw new Error("Invalid account signature");
    }

    const deviceMsg = concatBytes(
      new Uint8Array([6, 1]),
      account.details,
      creds.signedIdentityKey.public,
      account.accountSignatureKey
    );

    const deviceSignature = Curve.sign(
      creds.signedIdentityKey.private,
      deviceMsg
    );
    const updatedAccount = {
      ...account,
      deviceSignature,
    };

    const bizName = businessNode?.attrs.name;
    const jid = deviceNode.attrs.jid;
    const identity = this._createSignalIdentity(
      jid,
      account.accountSignatureKey
    );

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

    const deviceIdentity = fromBinary(
      ADVDeviceIdentitySchema,
      updatedAccount.details!
    );

    const reply: BinaryNode = {
      tag: "iq",
      attrs: {
        to: S_WHATSAPP_NET,
        type: "result",
        id: msgId,
      },
      content: [
        {
          tag: "pair-device-sign" as SINGLE_BYTE_TOKENS_TYPE,
          attrs: {},
          content: [
            {
              tag: "device-identity" as SINGLE_BYTE_TOKENS_TYPE,
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
    this.clearQrTimeout();

    try {
      const { creds: updatedCreds, reply } = this._configureSuccessfulPairing(
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

      Object.assign(this.authState.creds, updatedCreds);
      await this.authState.saveCreds();

      this.dispatchEvent(
        new CustomEvent("_internal.sendNode", { detail: reply })
      );
      this.logger.info("Sent pair-success confirmation reply");

      this.dispatchEvent(
        new CustomEvent("creds.update", { detail: updatedCreds })
      );
      this.dispatchEvent(
        new CustomEvent("connection.update", {
          detail: { isNewLogin: true, qr: undefined },
        })
      );

      this.logger.info(
        "Pairing complete, expecting connection close and restart"
      );
    } catch (error: any) {
      this.logger.error({ err: error }, "Error processing pair-success IQ");
      this.dispatchEvent(
        new CustomEvent("connection.update", {
          detail: { connection: "close", error },
        })
      );
      this.dispatchEvent(
        new CustomEvent("_internal.closeConnection", { detail: error })
      );
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
        .then(() =>
          this.dispatchEvent(
            new CustomEvent("creds.update", { detail: updates })
          )
        )
        .catch((err) =>
          this.logger.error({ err }, "Failed to save creds after login")
        );
    }

    this.dispatchEvent(
      new CustomEvent("connection.update", { detail: { connection: "open" } })
    );
  }

  private handleLoginFailure(node: BinaryNode): void {
    const reason = node.attrs.reason || "unknown";
    const code = parseInt(reason, 10) || 401;
    this.logger.error({ code, attrs: node.attrs }, "Login failed");
    const error = new Error(`Login failed: ${reason}`);
    (error as any).code = code;

    this.clearQrTimeout();
    this.dispatchEvent(
      new CustomEvent("connection.update", {
        detail: { connection: "close", error },
      })
    );
    this.dispatchEvent(
      new CustomEvent("_internal.closeConnection", { detail: error })
    );
  }
}

export { Authenticator };
export type { AuthenticatorEvents };
