import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	type CertChain,
	CertChainSchema,
	CertChain_NoiseCertificate_DetailsSchema,
	HandshakeMessageSchema,
} from "@wha.ts/proto";
import { NOISE_MODE, WHATSAPP_ROOT_CA_PUBLIC_KEY } from "../defaults";

import {
	bytesToHex,
	concatBytes,
	equalBytes,
	utf8ToBytes,
} from "@wha.ts/utils/src/bytes-utils";
import {
	aesDecryptGCM,
	aesEncryptGCM,
	hkdf,
	sha256,
} from "@wha.ts/utils/src/crypto";
import { Curve } from "@wha.ts/utils/src/curve";
import type { KeyPair } from "@wha.ts/utils/src/types";
import type { ILogger } from "./types";

interface NoiseState {
	handshakeHash: Uint8Array;
	salt: Uint8Array;
	encryptionKey: Uint8Array;
	decryptionKey: Uint8Array;
	readCounter: number;
	writeCounter: number;
	isHandshakeFinished: boolean;
	routingInfo?: Uint8Array;
	noisePrologue: Uint8Array;
	logger: ILogger;
}

export class NoiseProcessor {
	private state: NoiseState;

	constructor({
		localStaticKeyPair,
		noisePrologue,
		logger,
		routingInfo,
	}: {
		localStaticKeyPair: KeyPair;
		noisePrologue: Uint8Array;
		logger: ILogger;
		routingInfo?: Uint8Array;
	}) {
		const initialHashData = utf8ToBytes(NOISE_MODE);
		let handshakeHash =
			initialHashData.byteLength === 32
				? initialHashData
				: sha256(initialHashData);
		const salt = handshakeHash;
		const encryptionKey = handshakeHash;
		const decryptionKey = handshakeHash;

		handshakeHash = sha256(concatBytes(handshakeHash, noisePrologue));
		handshakeHash = sha256(
			concatBytes(handshakeHash, localStaticKeyPair.publicKey),
		);

		this.state = {
			handshakeHash,
			salt,
			encryptionKey,
			decryptionKey,
			readCounter: 0,
			writeCounter: 0,
			isHandshakeFinished: false,
			routingInfo,
			noisePrologue,
			logger,
		};
	}

	get isHandshakeFinished() {
		return this.state.isHandshakeFinished;
	}

	getState(): NoiseState {
		return this.state;
	}

	generateInitialHandshakeMessage(localEphemeralKeyPair: KeyPair): Uint8Array {
		const helloMsg = create(HandshakeMessageSchema, {
			clientHello: {
				ephemeral: localEphemeralKeyPair.publicKey,
			},
		});
		return toBinary(HandshakeMessageSchema, helloMsg);
	}

	private mixIntoHandshakeHash(data: Uint8Array) {
		if (!this.state.isHandshakeFinished) {
			this.state = {
				...this.state,
				handshakeHash: sha256(concatBytes(this.state.handshakeHash, data)),
			};
		}
	}

	private mixKeys(inputKeyMaterial: Uint8Array) {
		const key = hkdf(inputKeyMaterial, 64, {
			salt: this.state.salt,
			info: "",
		});
		const newSalt = key.subarray(0, 32);
		const keyUpdate = key.subarray(32);
		this.state = {
			...this.state,
			salt: newSalt,
			encryptionKey: keyUpdate,
			decryptionKey: keyUpdate,
			readCounter: 0,
			writeCounter: 0,
		};
	}

	async encryptMessage(plaintext: Uint8Array) {
		const nonce = this.generateIV(this.state.writeCounter);
		const ciphertext = await aesEncryptGCM(
			plaintext,
			this.state.encryptionKey,
			nonce,
			this.state.handshakeHash,
		);
		this.state = {
			...this.state,
			writeCounter: this.state.writeCounter + 1,
		};
		this.mixIntoHandshakeHash(ciphertext);
		return ciphertext;
	}

	async decryptMessage(ciphertext: Uint8Array) {
		const counter = this.state.isHandshakeFinished
			? this.state.readCounter
			: this.state.writeCounter;
		const nonce = this.generateIV(counter);
		const plaintext = await aesDecryptGCM(
			ciphertext,
			this.state.decryptionKey,
			nonce,
			this.state.handshakeHash,
		);
		this.state = {
			...this.state,
			readCounter: this.state.isHandshakeFinished
				? this.state.readCounter + 1
				: this.state.readCounter,
			writeCounter: this.state.isHandshakeFinished
				? this.state.writeCounter
				: this.state.writeCounter + 1,
		};
		this.mixIntoHandshakeHash(ciphertext);
		return plaintext;
	}

	finalizeHandshake() {
		const key = hkdf(new Uint8Array(0), 64, {
			salt: this.state.salt,
			info: "",
		});
		const finalWriteKey = key.subarray(0, 32);
		const finalReadKey = key.subarray(32);
		this.state = {
			...this.state,
			encryptionKey: finalWriteKey,
			decryptionKey: finalReadKey,
			handshakeHash: new Uint8Array(0),
			readCounter: 0,
			writeCounter: 0,
			isHandshakeFinished: true,
		};
	}

	async processHandshake(
		serverHelloBytes: Uint8Array,
		localStaticKeyPair: KeyPair,
		localEphemeralKeyPair: KeyPair,
	) {
		const { serverHello } = fromBinary(
			HandshakeMessageSchema,
			serverHelloBytes,
		);
		if (
			!serverHello?.ephemeral ||
			!serverHello?.static ||
			!serverHello?.payload
		) {
			throw new Error("Invalid serverHello message received");
		}
		this.mixIntoHandshakeHash(serverHello.ephemeral);
		this.mixKeys(
			Curve.sharedKey(localEphemeralKeyPair.privateKey, serverHello.ephemeral),
		);
		const decryptedServerStatic = await this.decryptMessage(serverHello.static);
		this.mixKeys(
			Curve.sharedKey(localEphemeralKeyPair.privateKey, decryptedServerStatic),
		);
		const decryptedPayload = await this.decryptMessage(serverHello.payload);
		const certChain = fromBinary(CertChainSchema, decryptedPayload);

		this.verifyCertificateChain(certChain, decryptedServerStatic);

		const encryptedLocalStaticPublic = await this.encryptMessage(
			localStaticKeyPair.publicKey,
		);
		this.mixKeys(
			Curve.sharedKey(localStaticKeyPair.privateKey, serverHello.ephemeral),
		);
		return encryptedLocalStaticPublic;
	}

	private verifyCertificateChain(
		certChain: CertChain,
		decryptedServerStatic: Uint8Array,
	): void {
		const leafCert = certChain.leaf;
		const intermediateCert = certChain.intermediate;

		if (!leafCert?.details || !leafCert.signature) {
			throw new Error(
				"Invalid certificate: Missing leaf certificate details or signature",
			);
		}
		if (!intermediateCert?.details || !intermediateCert.signature) {
			throw new Error(
				"Invalid certificate: Missing intermediate certificate details or signature",
			);
		}

		const leafCertDetailsBytes = leafCert.details;
		const intermediateCertDetailsBytes = intermediateCert.details;

		const leafCertDetails = fromBinary(
			CertChain_NoiseCertificate_DetailsSchema,
			leafCertDetailsBytes,
		);
		const intermediateCertDetails = fromBinary(
			CertChain_NoiseCertificate_DetailsSchema,
			intermediateCertDetailsBytes,
		);

		if (!leafCertDetails.key) {
			throw new Error(
				"Invalid certificate: Missing public key in leaf certificate details",
			);
		}
		if (!intermediateCertDetails.key) {
			throw new Error(
				"Invalid certificate: Missing public key in intermediate certificate details",
			);
		}

		const leafCertPubKey = leafCertDetails.key;
		const intermediateCertPubKey = intermediateCertDetails.key;

		// 1. Verify intermediate certificate signature with Root CA key
		const isIntermediateCertValid = Curve.verify(
			WHATSAPP_ROOT_CA_PUBLIC_KEY,
			intermediateCertDetailsBytes,
			intermediateCert.signature,
		);
		if (!isIntermediateCertValid) {
			this.state.logger.error(
				{},
				"Intermediate certificate validation failed!",
			);
			throw new Error(
				"Server certificate validation failed: Invalid intermediate certificate signature",
			);
		}

		// 2. Verify leaf certificate signature with intermediate cert key
		const isLeafCertValid = Curve.verify(
			intermediateCertPubKey,
			leafCertDetailsBytes,
			leafCert.signature,
		);
		if (!isLeafCertValid) {
			this.state.logger.error({}, "Leaf certificate validation failed!");
			throw new Error(
				"Server certificate validation failed: Invalid leaf certificate signature",
			);
		}

		// 3. Match decrypted server static key with leaf cert key
		if (!equalBytes(decryptedServerStatic, leafCertPubKey)) {
			this.state.logger.error(
				{
					decryptedKeyHex: bytesToHex(decryptedServerStatic),
					leafCertKeyHex: bytesToHex(leafCertPubKey),
				},
				"Server static key mismatch!",
			);
			throw new Error(
				"Server certificate validation failed: Decrypted server static key does not match leaf certificate public key",
			);
		}
	}

	private generateIV(counter: number) {
		const iv = new ArrayBuffer(12);
		new DataView(iv).setUint32(8, counter);
		return new Uint8Array(iv);
	}
}
