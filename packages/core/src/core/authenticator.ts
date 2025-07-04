import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { S_WHATSAPP_NET } from "@wha.ts/binary";
import { getBinaryNodeChild, getBinaryNodeChildren } from "@wha.ts/binary";
import type { BinaryNode } from "@wha.ts/binary";
import type { SINGLE_BYTE_TOKENS_TYPE } from "@wha.ts/binary";
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
} from "@wha.ts/utils";
import { hmacSign } from "@wha.ts/utils";
import { Curve, KEY_BUNDLE_TYPE } from "@wha.ts/utils";
import type { KeyPair } from "@wha.ts/utils";
import { encodeBigEndian } from "@wha.ts/utils";
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

	// Helper to generate a unique ID for IQs
	private generateIQId(prefix = "pk"): string {
		return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
	}

	// Helper to query available pre-keys on server
	private async getAvailablePreKeysOnServer(): Promise<number> {
		const iqId = this.generateIQId("prekey-count");
		const node: BinaryNode = {
			tag: "iq",
			attrs: {
				id: iqId,
				xmlns: "encrypt",
				type: "get",
				to: S_WHATSAPP_NET,
			},
			content: [{ tag: "count", attrs: {} }],
		};

		this.logger.debug("Querying server for pre-key count...");
		await this.connectionActions.sendNode(node);

		return new Promise<number>((resolve, reject) => {
			const listener = (event: TypedCustomEvent<{ node: BinaryNode }>) => {
				const responseNode = event.detail.node;
				if (responseNode.tag === "iq" && responseNode.attrs.id === iqId) {
					this.connectionManager.removeEventListener(
						"node.received",
						listener as EventListener,
					);
					if (responseNode.attrs.type === "result") {
						const countChild = getBinaryNodeChild(responseNode, "count");
						const count = Number.parseInt(countChild?.attrs.value || "0", 10);
						this.logger.info({ count }, "Received pre-key count from server");
						resolve(count);
					} else {
						const errorChild = getBinaryNodeChild(responseNode, "error");
						const errorMsg =
							errorChild?.attrs.text || "Unknown error fetching pre-key count";
						this.logger.error(
							{ errorMsg, node: responseNode },
							"Error fetching pre-key count",
						);
						reject(new Error(errorMsg));
					}
				}
			};
			this.connectionManager.addEventListener(
				"node.received",
				listener as EventListener,
			);
			setTimeout(() => {
				this.connectionManager.removeEventListener(
					"node.received",
					listener as EventListener,
				);
				reject(new Error("Timeout waiting for pre-key count response"));
			}, 15000);
		});
	}

	private setState(newState: AuthState): void {
		if (this.state !== newState) {
			this.state = newState;
			this.dispatchEvent(
				new CustomEvent("debug:authenticator:state_change", {
					detail: { state: newState },
				}),
			);
		}
	}

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
				this.setState(AuthState.FAILED);
				this.dispatchTypedEvent("connection.update", {
					connection: "close",
					error,
				});
			},
		);

		this.connectionManager.addEventListener("ws.close", () => {
			this.clearQrTimeout();
			this.setState(AuthState.IDLE);
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
		this.setState(AuthState.AWAITING_QR);

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

	private extractAndVerifyPairingData(
		pairSuccessNode: BinaryNode,
		creds: AuthenticationCreds,
	): {
		account: ADVSignedDeviceIdentity;
		platformName?: string;
		deviceJid: string;
		businessName?: string;
	} {
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

		return {
			account,
			platformName: platformNode?.attrs.name,
			deviceJid: deviceNode.attrs.jid,
			businessName: businessNode?.attrs.name,
		};
	}

	private createAuthUpdateFromPairingData(
		verifiedData: {
			account: ADVSignedDeviceIdentity;
			platformName?: string;
			deviceJid: string;
			businessName?: string;
		},
		creds: AuthenticationCreds,
	): Partial<AuthenticationCreds> {
		const identity = this._createSignalIdentity(
			verifiedData.deviceJid,
			verifiedData.account.accountSignatureKey,
		);

		return {
			me: { id: verifiedData.deviceJid, name: verifiedData.businessName },
			account: toJson(
				ADVSignedDeviceIdentitySchema,
				verifiedData.account,
			) as unknown as ADVSignedDeviceIdentity,
			signalIdentities: [...(creds.signalIdentities || []), identity],
			platform: verifiedData.platformName,
			pairingCode: undefined,
		};
	}

	private updateAccountWithDeviceSignature(
		account: ADVSignedDeviceIdentity,
		signedIdentityKey: KeyPair,
	): ADVSignedDeviceIdentity {
		const deviceMsg = concatBytes(
			new Uint8Array([6, 1]),
			account.details,
			signedIdentityKey.publicKey,
			account.accountSignatureKey,
		);
		const deviceSignature = Curve.sign(signedIdentityKey.privateKey, deviceMsg);
		return { ...account, deviceSignature };
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
		this.setState(AuthState.PROCESSING_PAIR_SUCCESS);
		this.clearQrTimeout();

		try {
			const msgId = node.attrs.id;
			if (!msgId) {
				throw new Error("Missing message ID in stanza for pair-success");
			}
			const pairSuccessNode = getBinaryNodeChild(node, "pair-success");
			if (!pairSuccessNode) throw new Error("Missing 'pair-success' in stanza");

			const verifiedData = this.extractAndVerifyPairingData(
				pairSuccessNode,
				this.authStateProvider.creds,
			);

			const accountWithDeviceSig = this.updateAccountWithDeviceSignature(
				verifiedData.account,
				this.authStateProvider.creds.signedIdentityKey,
			);

			const updatedCreds = this.createAuthUpdateFromPairingData(
				{ ...verifiedData, account: accountWithDeviceSig },
				this.authStateProvider.creds,
			);

			const reply = this.buildPairingReplyNode(msgId, accountWithDeviceSig);

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
			this.setState(AuthState.AUTHENTICATED);
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
			this.setState(AuthState.FAILED);
		}
	}

	private handleLoginSuccess(node: BinaryNode): void {
		this.clearQrTimeout();
		this.state = AuthState.AUTHENTICATED;

		// Pre-key replenishment logic
		const replenishLogic = async () => {
			try {
				await this.handleHandshakeComplete();

				// Only check and replenish if already registered
				if (this.authStateProvider.creds.registered) {
					// Import constants dynamically to avoid circular deps
					const { MIN_PREKEY_COUNT, PREKEY_UPLOAD_BATCH_SIZE } = await import(
						"../defaults"
					);
					const currentServerCount = await this.getAvailablePreKeysOnServer();
					this.logger.info(
						{ currentServerCount },
						"Pre-keys currently on server after login.",
					);
					if (currentServerCount < MIN_PREKEY_COUNT) {
						const needed = PREKEY_UPLOAD_BATCH_SIZE - currentServerCount;
						if (needed > 0) {
							this.logger.info({ needed }, "Replenishing pre-keys on relogin.");
							await this.uploadPreKeysBatch(needed);
						} else {
							this.logger.info(
								"Sufficient pre-keys on server, no replenishment needed now.",
							);
						}
					}
				}
			} catch (err) {
				this.logger.error(
					{ err },
					"Error during post-login pre-key management",
				);
			}

			// Continue with existing login success logic
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
		};

		replenishLogic().catch((err) => {
			this.logger.error(
				{ err },
				"Critical failure in login success/pre-key replenishment sequence",
			);
			const error = err instanceof Error ? err : new Error(String(err));
			this.dispatchTypedEvent("connection.update", {
				connection: "close",
				error,
			});
			this.connectionActions
				.closeConnection(error)
				.catch((closeErr) =>
					this.logger.error(
						{ closeErr },
						"Failed to close connection after pre-key error",
					),
				);
		});
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

	private async prepareInitialRegistrationPreKeys(batchCount = 30): Promise<{
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
		const { preKeys, updateCreds } =
			await this.prepareInitialRegistrationPreKeys();
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

	// Fetch a batch of pre-keys intended for upload
	private async getNextPreKeyBatchForUpload(batchSize: number): Promise<{
		keysToUpload: { [id: number]: KeyPair };
		idsUploaded: number[];
		nextFirstUnuploadedPreKeyId: number;
	}> {
		const { creds, keys } = this.authStateProvider;
		const { firstUnuploadedPreKeyId, nextPreKeyId } = creds;
		const availableToUpload = nextPreKeyId - firstUnuploadedPreKeyId;
		const countToFetch = Math.min(batchSize, availableToUpload);

		if (countToFetch <= 0) {
			this.logger.info("No pre-keys available locally to upload.");
			return {
				keysToUpload: {},
				idsUploaded: [],
				nextFirstUnuploadedPreKeyId: firstUnuploadedPreKeyId,
			};
		}

		const idsToFetch: string[] = [];
		const numericIdsUploaded: number[] = [];
		for (let i = 0; i < countToFetch; i++) {
			const keyId = firstUnuploadedPreKeyId + i;
			idsToFetch.push(keyId.toString());
			numericIdsUploaded.push(keyId);
		}

		this.logger.debug({ idsToFetch }, "Fetching pre-keys for upload batch");
		const fetchedKeys = (await keys.get("pre-key", idsToFetch)) as {
			[id: string]: KeyPair;
		};

		const keysToUpload: { [id: number]: KeyPair } = {};
		for (const idStr of idsToFetch) {
			if (fetchedKeys[idStr]) {
				keysToUpload[Number(idStr)] = fetchedKeys[idStr];
			} else {
				this.logger.warn(
					`Pre-key ${idStr} not found in local store for upload!`,
				);
			}
		}

		return {
			keysToUpload,
			idsUploaded: numericIdsUploaded,
			nextFirstUnuploadedPreKeyId: firstUnuploadedPreKeyId + countToFetch,
		};
	}

	// Generate and upload a batch of pre-keys
	private async uploadPreKeysBatch(count: number): Promise<void> {
		const { creds } = this.authStateProvider;
		const currentLocalUnuploadedCount =
			creds.nextPreKeyId - creds.firstUnuploadedPreKeyId;
		if (currentLocalUnuploadedCount < count) {
			const needToGenerate = count - currentLocalUnuploadedCount;
			this.logger.info(
				{ needToGenerate },
				"Generating additional pre-keys before batch upload",
			);
			const newLocalKeys = generatePreKeys(creds.nextPreKeyId, needToGenerate);
			await this.authStateProvider.keys.set({ "pre-key": newLocalKeys });
			creds.nextPreKeyId += needToGenerate;
		}

		const { keysToUpload, idsUploaded, nextFirstUnuploadedPreKeyId } =
			await this.getNextPreKeyBatchForUpload(count);

		if (Object.keys(keysToUpload).length === 0) {
			this.logger.info("No pre-keys to upload in this batch.");
			return;
		}

		const preKeyNodes = Object.entries(keysToUpload).map(([id, keyPair]) =>
			formatPreKeyForXMPP(keyPair, Number.parseInt(id, 10)),
		);

		const iqId = this.generateIQId("upload-pk");
		const uploadIQNode: BinaryNode = {
			tag: "iq",
			attrs: {
				xmlns: "encrypt",
				type: "set",
				to: S_WHATSAPP_NET,
				id: iqId,
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

		this.logger.info(
			{ count: preKeyNodes.length, ids: idsUploaded },
			"Uploading pre-keys batch",
		);
		await this.connectionActions.sendNode(uploadIQNode);

		return new Promise<void>((resolve, reject) => {
			const listener = (event: TypedCustomEvent<{ node: BinaryNode }>) => {
				const responseNode = event.detail.node;
				if (responseNode.tag === "iq" && responseNode.attrs.id === iqId) {
					this.connectionManager.removeEventListener(
						"node.received",
						listener as EventListener,
					);
					if (responseNode.attrs.type === "result") {
						this.logger.info("Pre-key batch uploaded successfully");
						creds.firstUnuploadedPreKeyId = nextFirstUnuploadedPreKeyId;
						this.authStateProvider
							.saveCreds()
							.then(() => {
								this.dispatchTypedEvent("creds.update", {
									firstUnuploadedPreKeyId: creds.firstUnuploadedPreKeyId,
									nextPreKeyId: creds.nextPreKeyId,
								});
								resolve();
							})
							.catch(reject);
					} else {
						const errorChild = getBinaryNodeChild(responseNode, "error");
						const errorMsg =
							errorChild?.attrs.text || "Unknown error uploading pre-key batch";
						this.logger.error(
							{ errorMsg, node: responseNode },
							"Error uploading pre-key batch",
						);
						reject(new Error(errorMsg));
					}
				}
			};
			this.connectionManager.addEventListener(
				"node.received",
				listener as EventListener,
			);
			setTimeout(() => {
				this.connectionManager.removeEventListener(
					"node.received",
					listener as EventListener,
				);
				reject(new Error("Timeout waiting for pre-key batch upload response"));
			}, 20000);
		});
	}

	public getDebugStateSnapshot(): {
		internalState: AuthState;
		qrRetryCount: number;
		credsSummary: Partial<AuthenticationCreds>;
	} {
		return {
			internalState: this.state,
			qrRetryCount: this.qrRetryCount,
			credsSummary: {
				me: this.authStateProvider.creds.me,
				platform: this.authStateProvider.creds.platform,
				registered: this.authStateProvider.creds.registered,
				signalIdentities: this.authStateProvider.creds.signalIdentities,
			},
		};
	}
}

export { Authenticator };
