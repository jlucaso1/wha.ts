import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import type { SINGLE_BYTE_TOKENS_TYPE } from "@wha.ts/binary/src/constants";
import { S_WHATSAPP_NET } from "@wha.ts/binary/src/jid-utils";
import {
	getBinaryNodeChild,
	getBinaryNodeChildren,
} from "@wha.ts/binary/src/node-utils";
import type { BinaryNode } from "@wha.ts/binary/src/types";
import {
	ADVDeviceIdentitySchema,
	type ADVSignedDeviceIdentity,
	type ADVSignedDeviceIdentityHMAC,
	ADVSignedDeviceIdentityHMACSchema,
	ADVSignedDeviceIdentitySchema,
} from "@wha.ts/proto";
import type {
	AuthenticationCreds,
	IAuthStateProvider,
} from "../state/interface";
import type { ILogger } from "../transport/types";
import type { ConnectionManager } from "./connection";

import {
	bytesToBase64,
	bytesToUtf8,
	concatBytes,
	equalBytes,
} from "@wha.ts/utils/src/bytes-utils";
import { hmacSign } from "@wha.ts/utils/src/crypto";
import { Curve, KEY_BUNDLE_TYPE } from "@wha.ts/utils/src/curve";
import { encodeBigEndian } from "@wha.ts/utils/src/encodeBigEndian";
import type { KeyPair } from "@wha.ts/utils/src/types";
import {
	type TypedCustomEvent,
	TypedEventTarget,
} from "../generics/typed-event-target";
import { generatePreKeys } from "../state/utils";
import {
	formatPreKeyForXMPP,
	formatSignedPreKeyForXMPP,
} from "./auth-payload-generators";
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

	private handleHandshakeComplete = async (): Promise<void> => {
		try {
			if (!this.authStateProvider.creds.registered) {
				this.logger.info("Performing initial registration: uploading pre-keys");
				const { node: regNode, updateCreds } =
					await this.generateRegistrationIQ();
				await this.connectionActions.sendNode(regNode);
				Object.assign(this.authStateProvider.creds, updateCreds);
				await this.authStateProvider.saveCreds();
				this.logger.info("Initial pre-keys uploaded and state updated");
			}
		} catch (error) {
			this.logger.error({ err: error }, "Registration (pre-key upload) failed");
			if (error instanceof Error) {
				this.dispatchTypedEvent("connection.update", {
					connection: "close",
					error,
				});
				await this.connectionActions.closeConnection(error as Error);
			}
		}
	};

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
		} else if (node.tag === "ib") {
			const offlinePreviewNode = getBinaryNodeChild(node, "offline_preview");
			if (offlinePreviewNode) {
				this.connectionActions.sendNode({
					tag: "ib",
					attrs: {},
					content: [{ tag: "offline_batch", attrs: { count: "30" } }],
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
			this.authStateProvider.creds.noiseKey.publicKey,
		);
		const identityKeyB64 = bytesToBase64(
			this.authStateProvider.creds.signedIdentityKey.publicKey,
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
		this.verifyDeviceIdentityHMAC(creds, hmacIdentity);

		const account = fromBinary(
			ADVSignedDeviceIdentitySchema,
			hmacIdentity.details,
		);
		this.verifyAccountSignature(account, creds);

		const deviceMsg = concatBytes(
			new Uint8Array([6, 1]),
			account.details,
			creds.signedIdentityKey.publicKey,
			account.accountSignatureKey,
		);

		const deviceSignature = Curve.sign(
			creds.signedIdentityKey.privateKey,
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
			account: toJson(
				ADVSignedDeviceIdentitySchema,
				updatedAccount,
			) as unknown as ADVSignedDeviceIdentity,
			signalIdentities: [...(creds.signalIdentities || []), identity],
			platform: platformNode?.attrs.name,
			pairingCode: undefined,
		};

		const reply = this.buildPairingReplyNode(msgId, updatedAccount);

		return { creds: authUpdate, reply };
	}

	private verifyDeviceIdentityHMAC(
		creds: AuthenticationCreds,
		hmacIdentity: ADVSignedDeviceIdentityHMAC,
	): void {
		const advSign = hmacSign(creds.advSecretKey, hmacIdentity.details);
		if (!equalBytes(hmacIdentity.hmac, advSign)) {
			throw new Error("Invalid ADV account signature HMAC");
		}
	}

	private verifyAccountSignature(
		account: ADVSignedDeviceIdentity,
		creds: AuthenticationCreds,
	): void {
		const accountMsg = concatBytes(
			new Uint8Array([6, 0]),
			account.details,
			creds.signedIdentityKey.publicKey,
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
	}

	private buildPairingReplyNode(
		msgId: string,
		updatedAccount: ADVSignedDeviceIdentity,
	): BinaryNode {
		const accountEnc = (() => {
			const replyAcc = create(ADVSignedDeviceIdentitySchema, updatedAccount);
			return toBinary(ADVSignedDeviceIdentitySchema, replyAcc);
		})();

		const deviceIdentity = fromBinary(
			ADVDeviceIdentitySchema,
			updatedAccount.details,
		);
		return {
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

		this.handleHandshakeComplete().catch((err) => {
			this.logger.error({ err }, "Error during handshake completion");
		});

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
				.then(() => {
					this.dispatchTypedEvent("creds.update", updates);
				})
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

	private async prepareRegistrationPreKeys(batchCount = 30): Promise<{
		preKeys: { [id: number]: KeyPair };
		updateCreds: Partial<AuthenticationCreds>;
	}> {
		const { creds, keys } = this.authStateProvider;
		const localKeyCount = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId;
		const keysToUploadCount = batchCount;
		const startId = creds.firstUnuploadedPreKeyId;
		let newKeys: { [id: number]: KeyPair } = {};

		if (localKeyCount < batchCount) {
			const needed = batchCount - localKeyCount;
			const generationStartId = creds.nextPreKeyId;
			newKeys = generatePreKeys(generationStartId, needed);
			await keys.set({ "pre-key": newKeys });
			creds.nextPreKeyId += needed;
		}

		const endId = startId + keysToUploadCount - 1;
		const idsToFetch = Array.from({ length: keysToUploadCount }, (_, i) =>
			(startId + i).toString(),
		);
		const fetchedKeys = await keys.get("pre-key", idsToFetch);
		const updateCreds: Partial<AuthenticationCreds> = {
			firstUnuploadedPreKeyId: endId + 1,
			nextPreKeyId: creds.nextPreKeyId,
		};
		return { preKeys: fetchedKeys as { [id: number]: KeyPair }, updateCreds };
	}

	private async generateRegistrationIQ(): Promise<{
		node: BinaryNode;
		updateCreds: Partial<AuthenticationCreds>;
	}> {
		const { creds } = this.authStateProvider;
		const { preKeys, updateCreds } = await this.prepareRegistrationPreKeys();
		const preKeyNodes = Object.entries(preKeys).map(([id, keyPair]) =>
			formatPreKeyForXMPP(keyPair, Number.parseInt(id, 10)),
		);
		const registrationIQ: BinaryNode = {
			tag: "iq",
			attrs: {
				xmlns: "encrypt",
				type: "set",
				to: S_WHATSAPP_NET,
				id: `reg-${Date.now()}`,
			},
			content: [
				{
					tag: "registration",
					attrs: {},
					content: encodeBigEndian(creds.registrationId),
				},
				{ tag: "type", attrs: {}, content: KEY_BUNDLE_TYPE },
				{
					tag: "identity",
					attrs: {},
					content: creds.signedIdentityKey.publicKey,
				},
				formatSignedPreKeyForXMPP(creds.signedPreKey),
				{ tag: "list", attrs: {}, content: preKeyNodes },
			],
		};
		return { node: registrationIQ, updateCreds };
	}
}

export { Authenticator };
