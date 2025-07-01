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
} from "@wha.ts/utils";
import { aesDecryptGCM, aesEncryptGCM, hkdf, sha256 } from "@wha.ts/utils";
import { Curve } from "@wha.ts/utils";
import type { KeyPair } from "@wha.ts/utils";
import { serializer } from "@wha.ts/utils";
import type { ILogger } from "./types";

interface NoiseState {
	handshakeHash: Uint8Array;
	salt: Uint8Array;
	encryptionKey: Uint8Array;
	decryptionKey: Uint8Array;
	readCounter: bigint;
	writeCounter: bigint;
	isHandshakeFinished: boolean;
	routingInfo?: Uint8Array;
	noisePrologue: Uint8Array;
	logger: ILogger;
}

export class NoiseProcessor extends EventTarget {
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
		super();
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
			readCounter: 0n,
			writeCounter: 0n,
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
			readCounter: 0n,
			writeCounter: 0n,
		};

		this.dispatchEvent(
			new CustomEvent("debug:noiseprocessor:state_update", {
				detail: { stateSnapshot: this.getDebugStateSnapshot() },
			}),
		);
	}

	encryptMessage(plaintext: Uint8Array) {
		const nonce = this.generateIV(this.state.writeCounter);
		const ciphertext = aesEncryptGCM(
			plaintext,
			this.state.encryptionKey,
			nonce,
			this.state.handshakeHash,
		);
		this.state = {
			...this.state,
			writeCounter: this.state.writeCounter + 1n,
		};
		this.mixIntoHandshakeHash(ciphertext);

		this.dispatchEvent(
			new CustomEvent("debug:noiseprocessor:payload_encrypted", {
				detail: {
					plaintext,
					ciphertext,
				},
			}),
		);
		return ciphertext;
	}

	decryptMessage(ciphertext: Uint8Array) {
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
				? this.state.readCounter + 1n
				: this.state.readCounter,
			writeCounter: this.state.isHandshakeFinished
				? this.state.writeCounter
				: this.state.writeCounter + 1n,
		};
		this.mixIntoHandshakeHash(ciphertext);
		// Emit debug event after decryption
		this.dispatchEvent(
			new CustomEvent("debug:noiseprocessor:payload_decrypted", {
				detail: {
					ciphertext,
					plaintext,
				},
			}),
		);
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
			readCounter: 0n,
			writeCounter: 0n,
			isHandshakeFinished: true,
		};

		this.dispatchEvent(
			new CustomEvent("debug:noiseprocessor:state_update", {
				detail: { stateSnapshot: this.getDebugStateSnapshot() },
			}),
		);
	}

	processHandshake(
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
		const decryptedServerStatic = this.decryptMessage(serverHello.static);
		this.mixKeys(
			Curve.sharedKey(localEphemeralKeyPair.privateKey, decryptedServerStatic),
		);
		const decryptedPayload = this.decryptMessage(serverHello.payload);
		const certChain = fromBinary(CertChainSchema, decryptedPayload);

		this.verifyCertificateChain(certChain, decryptedServerStatic);

		const encryptedLocalStaticPublic = this.encryptMessage(
			localStaticKeyPair.publicKey,
		);
		this.mixKeys(
			Curve.sharedKey(localStaticKeyPair.privateKey, serverHello.ephemeral),
		);
		return encryptedLocalStaticPublic;
	}

	getDebugStateSnapshot(): Readonly<NoiseState> {
		// Exclude logger from the snapshot to avoid serialization errors
		const { logger, ...rest } = this.state;
		return JSON.parse(serializer(rest));
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

	private generateIV(counter: bigint) {
		const iv = new ArrayBuffer(12);
		const view = new DataView(iv);
		view.setUint32(0, 0, false); // First 4 bytes zero
		view.setBigUint64(4, counter, false); // Last 8 bytes: big-endian counter
		return new Uint8Array(iv);
	}
}
