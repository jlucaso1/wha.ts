import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import {
	type CertChain,
	CertChain_NoiseCertificate_DetailsSchema,
	CertChainSchema,
	HandshakeMessageSchema,
} from "@wha.ts/proto";
import type { KeyPair } from "@wha.ts/utils";
import {
	aesDecryptGCM,
	aesEncryptGCM,
	bytesToHex,
	Curve,
	concatBytes,
	equalBytes,
	hkdf,
	serializer,
	sha256,
	utf8ToBytes,
} from "@wha.ts/utils";
import { NOISE_MODE, WHATSAPP_ROOT_CA_PUBLIC_KEY } from "../defaults";
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
	private logger: ILogger;

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
		this.logger = logger;
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

		logger.debug(
			{ initialState: this.getDebugStateSnapshot() },
			"NoiseProcessor initialized",
		);
	}

	get isHandshakeFinished() {
		return this.state.isHandshakeFinished;
	}

	getState(): NoiseState {
		return this.state;
	}

	generateInitialHandshakeMessage(localEphemeralKeyPair: KeyPair): Uint8Array {
		this.logger.debug(
			{
				ephemeralPublic: bytesToHex(localEphemeralKeyPair.publicKey),
			},
			"Generating ClientHello",
		);

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
		this.logger.debug(
			{ inputKeyMaterial: bytesToHex(inputKeyMaterial) },
			"Mixing keys",
		);

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

		this.logger.debug(
			{ newState: this.getDebugStateSnapshot() },
			"Keys mixed, state updated",
		);

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
		this.logger.debug("Finalizing handshake, switching to transport mode");

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

		this.logger.debug(
			{ finalState: this.getDebugStateSnapshot() },
			"Handshake finalized",
		);

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
		this.logger.debug("Processing ServerHello handshake message...");
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

		this.logger.debug(
			{ serverEphemeral: bytesToHex(serverHello.ephemeral) },
			"Handshake Step 1: Mixing server ephemeral key",
		);
		this.mixIntoHandshakeHash(serverHello.ephemeral);
		this.mixKeys(
			Curve.sharedKey(localEphemeralKeyPair.privateKey, serverHello.ephemeral),
		);
		this.logger.debug(
			{ encryptedStatic: bytesToHex(serverHello.static) },
			"Handshake Step 2: Decrypting server static key",
		);
		const decryptedServerStatic = this.decryptMessage(serverHello.static);
		this.logger.debug(
			{ decryptedStatic: bytesToHex(decryptedServerStatic) },
			"Handshake Step 2: Server static key decrypted",
		);
		this.mixKeys(
			Curve.sharedKey(localEphemeralKeyPair.privateKey, decryptedServerStatic),
		);
		this.logger.debug(
			{ encryptedPayload: bytesToHex(serverHello.payload) },
			"Handshake Step 3: Decrypting server payload (certificate)",
		);
		const decryptedPayload = this.decryptMessage(serverHello.payload);
		const certChain = fromBinary(CertChainSchema, decryptedPayload);
		this.logger.debug(
			{ certChain: toJson(CertChainSchema, certChain) },
			"Handshake Step 3: Server payload decrypted",
		);

		this.logger.debug("Handshake Step 4: Verifying certificate chain");
		this.verifyCertificateChain(certChain, decryptedServerStatic);
		this.logger.debug(
			"Handshake Step 4: Certificate chain verified successfully",
		);

		this.logger.debug(
			{ localStaticPublic: bytesToHex(localStaticKeyPair.publicKey) },
			"Handshake Step 5: Encrypting local static key",
		);
		const encryptedLocalStaticPublic = this.encryptMessage(
			localStaticKeyPair.publicKey,
		);
		this.logger.debug(
			{ encrypted: bytesToHex(encryptedLocalStaticPublic) },
			"Handshake Step 5: Local static key encrypted",
		);
		this.mixKeys(
			Curve.sharedKey(localStaticKeyPair.privateKey, serverHello.ephemeral),
		);

		this.logger.debug("Finished processing ServerHello successfully.");
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
		this.logger.debug("Verifying server certificate chain...");
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
		this.logger.debug("Verifying intermediate certificate against root CA...");
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
		this.logger.debug("Intermediate certificate signature OK");

		// 2. Verify leaf certificate signature with intermediate cert key
		this.logger.debug(
			"Verifying leaf certificate against intermediate cert...",
		);
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
		this.logger.debug("Leaf certificate signature OK");

		// 3. Match decrypted server static key with leaf cert key
		this.logger.debug(
			"Matching decrypted server static key with leaf cert key...",
		);
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
		this.logger.debug(
			"Server static key matches leaf certificate key. Verification successful.",
		);
	}

	private generateIV(counter: bigint) {
		const iv = new ArrayBuffer(12);
		const view = new DataView(iv);
		view.setUint32(0, 0, false); // First 4 bytes zero
		view.setBigUint64(4, counter, false); // Last 8 bytes: big-endian counter
		return new Uint8Array(iv);
	}
}
