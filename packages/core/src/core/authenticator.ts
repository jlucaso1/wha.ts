import type {
	AuthenticationCreds,
	IAuthStateProvider,
} from "../state/interface";
import type { ILogger } from "../transport/types";
import type { ConnectionManager } from "./connection";

import { fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import type { SINGLE_BYTE_TOKENS_TYPE } from "@wha.ts/binary/constants";
import { S_WHATSAPP_NET } from "@wha.ts/binary/src/jid-utils";
import {
	getBinaryNodeChild,
	getBinaryNodeChildren,
} from "@wha.ts/binary/src/node-utils";
import type { BinaryNode } from "@wha.ts/binary/src/types";
import {
	ADVDeviceIdentitySchema,
	ADVSignedDeviceIdentityHMACSchema,
	ADVSignedDeviceIdentitySchema,
} from "@wha.ts/proto";
import { Curve, hmacSign } from "../signal/crypto";
import {
	bytesToBase64,
	bytesToHex,
	bytesToUtf8,
	concatBytes,
	equalBytes,
} from "../utils/bytes-utils";
import {
	type TypedCustomEvent,
	TypedEventTarget,
} from "../utils/typed-event-target";
import type { AuthenticatorEventMap } from "./authenticator-events";
import type { IConnectionActions } from "./types";

enum AuthState {
	IDLE = "IDLE",
	AWAITING_QR = "AWAITING_QR",
	PROCESSING_PAIR_SUCCESS = "PROCESSING_PAIR_SUCCESS",
	AUTHENTICATED = "AUTHENTICATED",
	FAILED = "FAILED",
}

class Authenticator extends TypedEventTarget<AuthenticatorEventMap> {
	private connectionManager: ConnectionManager;
	private authStateProvider: IAuthStateProvider;
	private logger: ILogger;
	private connectionActions: IConnectionActions;
	private qrTimeout?: ReturnType<typeof setTimeout>;
	private qrRetryCount = 0;
	private sentOfflineBatch = false;
	private state: AuthState = AuthState.IDLE;

	private initialQrTimeoutMs = 60_000;
	private subsequentQrTimeoutMs = 20_000;

	constructor(
		connectionManager: ConnectionManager,
		authStateProvider: IAuthStateProvider,
		logger: ILogger,
		connectionActions: IConnectionActions,
	) {
		super();
		this.connectionManager = connectionManager;
		this.authStateProvider = authStateProvider;
		this.logger = logger;
		this.connectionActions = connectionActions;

		this.connectionManager.addEventListener(
			"handshake.complete",
			this.handleHandshakeComplete,
		);

		this.connectionManager.addEventListener(
			"node.received",
			(event: TypedCustomEvent<{ node: BinaryNode }>) => {
				this.handleNodeReceived(event.detail.node);
			},
		);

		this.connectionManager.addEventListener(
			"error",
			(event: TypedCustomEvent<{ error: Error }>) => {
				const error = event.detail.error;
				this.logger.error({ err: error }, "Connection error");
				this.clearQrTimeout();
				this.state = AuthState.FAILED;
				this.dispatchTypedEvent("connection.update", {
					connection: "close",
					error,
				});
			},
		);

		this.connectionManager.addEventListener("ws.close", () => {
			this.clearQrTimeout();
			this.state = AuthState.IDLE;
		});
	}

	private clearQrTimeout(): void {
		if (this.qrTimeout) {
			clearTimeout(this.qrTimeout);
			this.qrTimeout = undefined;
		}
	}

	private handleHandshakeComplete = async (): Promise<void> => {};

	private handleNodeReceived = (node: BinaryNode): void => {
		if (node.tag === "iq") {
			if (
				getBinaryNodeChild(node, "pair-device") &&
				node.attrs.type === "set"
			) {
				this.handlePairDeviceIQ(node);
			} else if (getBinaryNodeChild(node, "pair-success")) {
				this.handlePairSuccessIQ(node);
			}
		} else if (node.tag === "success") {
			this.handleLoginSuccess(node);
		} else if (node.tag === "fail") {
			this.handleLoginFailure(node);
		}

		// This is a temporary fix because the server is sending two exactly the same in the same time and if we send the two we got an error later
		if (node.tag === ("ib" as any) && !this.sentOfflineBatch) {
			const offlinePreviewNode = getBinaryNodeChild(node, "offline_preview");
			if (offlinePreviewNode) {
				console.log(JSON.stringify(node, null, 2));
				this.sentOfflineBatch = true;

				this.connectionActions.sendNode({
					tag: "ib" as any,
					attrs: {},
					content: [{ tag: "offline_batch" as any, attrs: { count: "100" } }],
				});
			}
		}
	};

	private handlePairDeviceIQ(node: BinaryNode): void {
		this.state = AuthState.AWAITING_QR;

		if (!node.attrs.id) {
			throw new Error("Missing message ID in stanza for pair-device");
		}

		if (!node.attrs.from) {
			throw new Error("Missing 'from' attribute in pair-device node");
		}

		const ackNode: BinaryNode = {
			tag: "iq",
			attrs: {
				to: node.attrs.from,
				type: "result",
				id: node.attrs.id,
			},
		};

		this.connectionActions
			.sendNode(ackNode)
			.catch((err) =>
				this.logger.error({ err }, "Failed to send pair-device ACK"),
			);

		const pairDeviceNode = getBinaryNodeChild(node, "pair-device");

		if (!pairDeviceNode) {
			throw new Error("Missing 'pair-device' in stanza");
		}

		const refNodes = getBinaryNodeChildren(pairDeviceNode, "ref");

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
			this.dispatchTypedEvent("connection.update", {
				connection: "close",
				error,
			});
			this.connectionActions
				.closeConnection(error)
				.catch((err) =>
					this.logger.error({ err }, "Failed to trigger connection close"),
				);
			return;
		}

		if (!(refNode.content instanceof Uint8Array)) {
			throw new Error("Invalid reference node content");
		}

		const ref = bytesToUtf8(refNode.content);
		const noiseKeyB64 = bytesToBase64(
			this.authStateProvider.creds.noiseKey.public,
		);
		const identityKeyB64 = bytesToBase64(
			this.authStateProvider.creds.signedIdentityKey.public,
		);
		const advSecretB64 = bytesToBase64(
			this.authStateProvider.creds.advSecretKey,
		);

		const qr = [ref, noiseKeyB64, identityKeyB64, advSecretB64].join(",");

		this.dispatchTypedEvent("connection.update", { qr });

		const timeoutMs =
			this.qrRetryCount === 0
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

	private processPairingSuccessData(
		stanza: BinaryNode,
		creds: AuthenticationCreds,
	): {
		creds: Partial<AuthenticationCreds>;
		reply: BinaryNode;
	} {
		const msgId = stanza.attrs.id;
		if (!msgId) {
			throw new Error("Missing message ID in stanza for pair-success");
		}

		const pairSuccessNode = getBinaryNodeChild(stanza, "pair-success");
		if (!pairSuccessNode) throw new Error("Missing 'pair-success' in stanza");

		const deviceIdentityNode = getBinaryNodeChild(
			pairSuccessNode,
			"device-identity",
		);
		const platformNode = getBinaryNodeChild(pairSuccessNode, "platform");
		const deviceNode = getBinaryNodeChild(pairSuccessNode, "device");
		const businessNode = getBinaryNodeChild(pairSuccessNode, "biz");

		if (!deviceIdentityNode?.content || !deviceNode?.attrs.jid) {
			throw new Error(
				"Missing device-identity content or device jid in pair-success node",
			);
		}

		if (!(deviceIdentityNode.content instanceof Uint8Array)) {
			throw new Error("Invalid device-identity content");
		}

		const hmacIdentity = fromBinary(
			ADVSignedDeviceIdentityHMACSchema,
			deviceIdentityNode.content,
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
			hmacIdentity.details,
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
			creds.signedIdentityKey.public,
		);

		if (
			!Curve.verify(
				account.accountSignatureKey,
				accountMsg,
				account.accountSignature,
			)
		) {
			throw new Error("Invalid account signature");
		}

		const deviceMsg = concatBytes(
			new Uint8Array([6, 1]),
			account.details,
			creds.signedIdentityKey.public,
			account.accountSignatureKey,
		);

		const deviceSignature = Curve.sign(
			creds.signedIdentityKey.private,
			deviceMsg,
		);
		const updatedAccount = {
			...account,
			deviceSignature,
		};

		const bizName = businessNode?.attrs.name;
		const jid = deviceNode.attrs.jid;
		const identity = this._createSignalIdentity(
			jid,
			account.accountSignatureKey,
		);

		const authUpdate: Partial<AuthenticationCreds> = {
			me: { id: jid, name: bizName },
			account: toJson(ADVSignedDeviceIdentitySchema, updatedAccount) as any,
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

		if (!updatedAccount.details) {
			throw new Error("Missing device identity details");
		}

		const deviceIdentity = fromBinary(
			ADVDeviceIdentitySchema,
			updatedAccount.details,
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
		if (this.state === AuthState.PROCESSING_PAIR_SUCCESS) {
			this.logger.warn("Already processing pair-success, ignoring duplicate");
			return;
		}
		this.state = AuthState.PROCESSING_PAIR_SUCCESS;
		this.clearQrTimeout();

		try {
			const { creds: updatedCreds, reply } = this.processPairingSuccessData(
				node,
				this.authStateProvider.creds,
			);

			this.logger.info(
				{
					jid: updatedCreds.me?.id,
					platform: updatedCreds.platform,
				},
				"Pairing successful, updating creds",
			);

			Object.assign(this.authStateProvider.creds, updatedCreds);
			await this.authStateProvider.saveCreds();

			await this.connectionActions.sendNode(reply);
			this.logger.info("Sent pair-success confirmation reply");

			this.dispatchTypedEvent("creds.update", updatedCreds);

			this.dispatchTypedEvent("connection.update", {
				isNewLogin: true,
				qr: undefined,
			});

			this.logger.info(
				"Pairing complete, expecting connection close and restart",
			);
			this.state = AuthState.AUTHENTICATED;
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}

			this.logger.error({ err: error }, "Error processing pair-success IQ");
			this.dispatchTypedEvent("connection.update", {
				connection: "close",
				error,
			});
			this.connectionActions
				.closeConnection(error)
				.catch((err) =>
					this.logger.error({ err }, "Failed to trigger connection close"),
				);
			this.state = AuthState.FAILED;
		}
	}

	private handleLoginSuccess(node: BinaryNode): void {
		this.clearQrTimeout();
		this.state = AuthState.AUTHENTICATED;

		const platform = node.attrs.platform;
		const pushname = node.attrs.pushname;
		const updates: Partial<AuthenticationCreds> = {};
		if (platform && this.authStateProvider.creds.platform !== platform) {
			updates.platform = platform;
		}
		if (
			pushname &&
			this.authStateProvider.creds.me?.name !== pushname &&
			this.authStateProvider.creds.me
		) {
			updates.me = { ...this.authStateProvider.creds.me, name: pushname };
		}
		if (!this.authStateProvider.creds.registered) {
			updates.registered = true;
		}

		if (Object.keys(updates).length > 0) {
			this.logger.info({ updates }, "Updating creds after login success");
			Object.assign(this.authStateProvider.creds, updates);
			this.authStateProvider
				.saveCreds()
				.then(() => this.dispatchTypedEvent("creds.update", updates))
				.catch((err) =>
					this.logger.error({ err }, "Failed to save creds after login"),
				);
		}

		this.dispatchTypedEvent("connection.update", { connection: "open" });
	}

	private handleLoginFailure(node: BinaryNode): void {
		const reason = node.attrs.reason || "unknown";
		const code = Number.parseInt(reason, 10) || 401;
		this.logger.error({ code, attrs: node.attrs }, "Login failed");
		const error = new Error(`Login failed: ${reason}`);

		this.clearQrTimeout();
		this.state = AuthState.FAILED;
		this.dispatchTypedEvent("connection.update", {
			connection: "close",
			error,
		});
		this.connectionActions
			.closeConnection(error)
			.catch((err) =>
				this.logger.error({ err }, "Failed to trigger connection close"),
			);
	}
}

export { Authenticator };
