import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import type { BinaryNode, SINGLE_BYTE_TOKENS_TYPE } from "@wha.ts/binary";
import {
	getBinaryNodeChild,
	getBinaryNodeChildren,
	S_WHATSAPP_NET,
} from "@wha.ts/binary";
import {
	ADVDeviceIdentitySchema,
	type ADVSignedDeviceIdentity,
	type ADVSignedDeviceIdentityHMAC,
	ADVSignedDeviceIdentityHMACSchema,
	ADVSignedDeviceIdentitySchema,
} from "@wha.ts/proto";
import type { AuthenticationCreds, IAuthStateProvider } from "@wha.ts/types";
import {
	type TypedCustomEvent,
	TypedEventTarget,
} from "@wha.ts/types/generics/typed-event-target";
import type { KeyPair } from "@wha.ts/utils";
import { Curve, concatBytes, equalBytes, hmacSign } from "@wha.ts/utils";
import type { ILogger } from "../transport/types";
import type { AuthenticatorEventMap } from "./authenticator-events";
import type { ConnectionManager } from "./connection";
import { QRCodeGenerator } from "./qrcode";
import type { ErrorWithStatusCode, IConnectionActions } from "./types";

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
	private qrCodeGenerator: QRCodeGenerator;
	private state: AuthState = AuthState.IDLE;

	private setState(newState: AuthState): void {
		if (this.state !== newState) {
			this.state = newState;
		}
	}

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
		this.qrCodeGenerator = new QRCodeGenerator(authStateProvider, logger);

		this.qrCodeGenerator.addEventListener(
			"qr",
			(event: TypedCustomEvent<{ qr: string }>) => {
				this.dispatchTypedEvent("connection.update", { qr: event.detail.qr });
			},
		);

		this.qrCodeGenerator.addEventListener(
			"error",
			(event: TypedCustomEvent<{ error: Error }>) => {
				const { error } = event.detail;
				this.dispatchTypedEvent("connection.update", {
					connection: "close",
					error,
				});
				this.connectionActions
					.closeConnection(error)
					.catch((err) =>
						this.logger.error({ err }, "Failed to trigger connection close"),
					);
			},
		);

		this.connectionManager.addEventListener(
			"node.received",
			(event: TypedCustomEvent<{ node: BinaryNode }>) => {
				this.handleNodeReceived(event.detail.node);
			},
		);

		this.connectionManager.addEventListener(
			"error",
			(event: TypedCustomEvent<{ error: ErrorWithStatusCode }>) => {
				const error = event.detail.error;
				this.logger.error({ err: error }, "Connection error");
				this.qrCodeGenerator.stop();
				this.setState(AuthState.FAILED);
				this.dispatchTypedEvent("connection.update", {
					connection: "close",
					error,
					statusCode: error?.statusCode,
				});
			},
		);

		this.connectionManager.addEventListener("ws.close", () => {
			this.qrCodeGenerator.stop();
			this.setState(AuthState.IDLE);
		});
	}

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

		this.qrCodeGenerator.start(refNodes);
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
		this.qrCodeGenerator.stop();

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
		this.qrCodeGenerator.stop();
		console.log("Login successful", node);
		this.state = AuthState.AUTHENTICATED;

		const platform = node.attrs.platform;
		const pushname = node.attrs.pushname;
		const lid = node.attrs.lid;

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

		if (lid) {
			updates.me = {
				...this.authStateProvider.creds.me,
				lid,
			} as AuthenticationCreds["me"];
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

		this.qrCodeGenerator.stop();
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
