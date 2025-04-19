import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	CertChainSchema,
	CertChain_NoiseCertificate_DetailsSchema,
	HandshakeMessageSchema,
} from "@wha.ts/proto";
import { NOISE_MODE, WA_CERT_DETAILS } from "../defaults";

import { concatBytes, utf8ToBytes } from "@wha.ts/utils/src/bytes-utils";
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
		const ciphertext = aesEncryptGCM(
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
		const plaintext = aesDecryptGCM(
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
		const intermediateCertDetailsBytes = certChain.intermediate?.details;
		if (!intermediateCertDetailsBytes) {
			throw new Error(
				"Invalid certificate: Missing intermediate certificate details",
			);
		}
		const decodedCertDetails = fromBinary(
			CertChain_NoiseCertificate_DetailsSchema,
			intermediateCertDetailsBytes,
		);
		const issuerSerial = decodedCertDetails.issuerSerial;
		if (issuerSerial === null || issuerSerial !== WA_CERT_DETAILS.SERIAL) {
			this.state.logger.error(
				{
					expected: WA_CERT_DETAILS.SERIAL,
					received: issuerSerial,
				},
				"Certificate serial mismatch",
			);
			throw new Error(
				`Server certificate validation failed. Expected serial ${WA_CERT_DETAILS.SERIAL}, received ${issuerSerial}`,
			);
		}
		const encryptedLocalStaticPublic = await this.encryptMessage(
			localStaticKeyPair.publicKey,
		);
		this.mixKeys(
			Curve.sharedKey(localStaticKeyPair.privateKey, serverHello.ephemeral),
		);
		return encryptedLocalStaticPublic;
	}

	private generateIV(counter: number) {
		const iv = new ArrayBuffer(12);
		new DataView(iv).setUint32(8, counter);
		return new Uint8Array(iv);
	}
}
