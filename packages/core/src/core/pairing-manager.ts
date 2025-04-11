import type {
	AuthenticationCreds,
	IAuthStateProvider,
} from "../state/interface";
import type { ILogger } from "../transport/types";

import type { SINGLE_BYTE_TOKENS_TYPE } from "@wha.ts/binary/constants";
import {
	getBinaryNodeChild,
	getBinaryNodeChildren,
} from "@wha.ts/binary/src/node-utils";
import type { BinaryNode } from "@wha.ts/binary/src/types";
import { bytesToBase64, bytesToUtf8 } from "../utils/bytes-utils";
import { TypedEventTarget } from "../utils/typed-event-target";
import type { PairingManagerEventMap } from "./pairing-events";

type SendNodeCallback = (node: BinaryNode) => void;
type CloseConnectionCallback = (error: Error) => void;

export class PairingManager extends TypedEventTarget<PairingManagerEventMap> {
	private logger: ILogger;
	private authStateProvider: IAuthStateProvider;
	private sendNode: SendNodeCallback;
	private closeConnection: CloseConnectionCallback;

	// QR state
	private qrTimeout?: ReturnType<typeof setTimeout>;
	private qrRetryCount = 0;
	private initialQrTimeoutMs = 60_000;
	private subsequentQrTimeoutMs = 20_000;
	private processingPairSuccess = false;

	constructor(
		logger: ILogger,
		authStateProvider: IAuthStateProvider,
		sendNode: SendNodeCallback,
		closeConnection: CloseConnectionCallback,
	) {
		super();
		this.logger = logger;
		this.authStateProvider = authStateProvider;
		this.sendNode = sendNode;
		this.closeConnection = closeConnection;
	}

	clearQrTimeout(): void {
		if (this.qrTimeout) {
			clearTimeout(this.qrTimeout);
			this.qrTimeout = undefined;
		}
	}

	handlePairDeviceIQ(node: BinaryNode): void {
		this.processingPairSuccess = false;

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

		this.sendNode(ackNode);

		// Extract refs and start QR flow
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
			this.dispatchTypedEvent("pairing.failure", { error });
			this.closeConnection(error);
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

		this.dispatchTypedEvent("qr.update", { qr });

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
	async handlePairSuccessIQ(node: BinaryNode): Promise<void> {
		if (this.processingPairSuccess) {
			this.logger.warn("Already processing pair-success, ignoring duplicate");
			return;
		}
		this.processingPairSuccess = true;
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

			this.sendNode(reply);
			this.logger.info("Sent pair-success confirmation reply");

			this.dispatchTypedEvent("pairing.success", {
				creds: updatedCreds,
				reply,
			});
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			this.logger.error({ err: error }, "Error processing pair-success IQ");
			this.dispatchTypedEvent("pairing.failure", { error });
			this.closeConnection(error);
		} finally {
			this.processingPairSuccess = false;
		}
	}

	private processPairingSuccessData(
		stanza: BinaryNode,
		creds: AuthenticationCreds,
	): {
		creds: Partial<AuthenticationCreds>;
		reply: BinaryNode;
	} {
		// --- Begin migrated logic from Authenticator.processPairingSuccessData ---
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

		// The following imports are assumed to be available in the file:
		// fromBinary, toBinary, ADVSignedDeviceIdentityHMACSchema, ADVSignedDeviceIdentitySchema, ADVDeviceIdentitySchema, S_WHATSAPP_NET, Curve, hmacSign, equalBytes, bytesToHex, concatBytes

		// These will need to be imported at the top of the file for this to work.

		const { fromBinary, toBinary } = require("@bufbuild/protobuf");
		const {
			ADVSignedDeviceIdentityHMACSchema,
			ADVSignedDeviceIdentitySchema,
			ADVDeviceIdentitySchema,
		} = require("@wha.ts/proto");
		const { S_WHATSAPP_NET } = require("@wha.ts/binary/src/jid-utils");
		const { Curve } = require("../signal/crypto");
		const {
			hmacSign,
			equalBytes,
			bytesToHex,
			concatBytes,
		} = require("../utils/bytes-utils");

		const hmacIdentity = fromBinary(
			ADVSignedDeviceIdentityHMACSchema,
			deviceIdentityNode.content,
		);

		if (!hmacIdentity.details || !hmacIdentity.hmac) {
			throw new Error("Invalid ADVSignedDeviceIdentityHMAC structure");
		}

		const advSign = hmacSign(hmacIdentity.details, creds.advSecretKey);

		if (!equalBytes(hmacIdentity.hmac, advSign)) {
			this.logger.error("HMAC Details:", bytesToHex(hmacIdentity.details));
			this.logger.error("ADV Key:", bytesToHex(creds.advSecretKey));
			this.logger.error("Received HMAC:", bytesToHex(hmacIdentity.hmac));
			this.logger.error("Calculated HMAC:", bytesToHex(advSign));
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
		// --- End migrated logic ---
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
}
