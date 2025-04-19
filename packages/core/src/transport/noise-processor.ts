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

		console.log(`[Client] Initial handshakeHash: ${require("@wha.ts/utils/src/bytes-utils").bytesToHex(handshakeHash)}`);

		handshakeHash = sha256(concatBytes(handshakeHash, noisePrologue));
		console.log(`[Client] After mixing prologue: ${require("@wha.ts/utils/src/bytes-utils").bytesToHex(handshakeHash)}`);

		handshakeHash = sha256(
			concatBytes(handshakeHash, localStaticKeyPair.publicKey),
		);
		console.log(`[Client] After mixing local static pubkey: ${require("@wha.ts/utils/src/bytes-utils").bytesToHex(handshakeHash)}`);

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
			const before = this.state.handshakeHash;
			const after = sha256(concatBytes(this.state.handshakeHash, data));
			console.log(`[Client] mixIntoHandshakeHash: before=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(before)}, data=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(data)}, after=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(after)}`);
			this.state = {
				...this.state,
				handshakeHash: after,
			};
		}
	}

	private mixKeys(inputKeyMaterial: Uint8Array) {
		console.log(`[Client] mixKeys: inputKeyMaterial=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(inputKeyMaterial)}, salt(before)=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(this.state.salt)}`);
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
		console.log(`[Client] mixKeys: salt(after)=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(newSalt)}, cipherKey=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(keyUpdate)}`);
	}

	async encryptMessage(plaintext: Uint8Array) {
		const nonce = this.generateIV(this.state.writeCounter);
		console.log(`[Client] encryptMessage: plaintextLen=${plaintext.length}, key=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(this.state.encryptionKey)}, nonce=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(nonce)}, aad=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(this.state.handshakeHash)}`);
		const ciphertext = aesEncryptGCM(
			plaintext,
			this.state.encryptionKey,
			nonce,
			this.state.handshakeHash,
		);
		console.log(`[Client] encryptMessage: ciphertextLen=${ciphertext.length}, ciphertext=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(ciphertext)}`);
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
		console.log(`[Client] decryptMessage: ciphertextLen=${ciphertext.length}, key=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(this.state.decryptionKey)}, nonce=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(nonce)}, aad=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(this.state.handshakeHash)}`);
		const plaintext = aesDecryptGCM(
			ciphertext,
			this.state.decryptionKey,
			nonce,
			this.state.handshakeHash,
		);
		console.log(`[Client] decryptMessage: plaintextLen=${plaintext.length}, plaintext=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(plaintext)}`);
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
		console.log(`[Client] After mixing server ephemeral: handshakeHash=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(this.state.handshakeHash)}`);

		const dh_ee = Curve.sharedKey(localEphemeralKeyPair.privateKey, serverHello.ephemeral);
		console.log(`[Client] DH(e, re): local eph priv=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(localEphemeralKeyPair.privateKey)}, server eph pub=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(serverHello.ephemeral)}, result=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(dh_ee)}`);
		this.mixKeys(dh_ee);

		const decryptedServerStatic = await this.decryptMessage(serverHello.static);
		console.log(`[Client] After decrypting server static: handshakeHash=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(this.state.handshakeHash)}, nonce=${this.state.readCounter}`);

		const dh_es = Curve.sharedKey(localEphemeralKeyPair.privateKey, decryptedServerStatic);
		console.log(`[Client] DH(e, rs): local eph priv=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(localEphemeralKeyPair.privateKey)}, server static pub=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(decryptedServerStatic)}, result=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(dh_es)}`);
		this.mixKeys(dh_es);

		const decryptedPayload = await this.decryptMessage(serverHello.payload);
		console.log(`[Client] After decrypting payload: handshakeHash=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(this.state.handshakeHash)}, nonce=${this.state.readCounter}`);

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

		const dh_se = Curve.sharedKey(localStaticKeyPair.privateKey, serverHello.ephemeral);
		console.log(`[Client] DH(s, re): local static priv=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(localStaticKeyPair.privateKey)}, server eph pub=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(serverHello.ephemeral)}, result=${require("@wha.ts/utils/src/bytes-utils").bytesToHex(dh_se)}`);
		this.mixKeys(dh_se);

		return encryptedLocalStaticPublic;
	}

	private generateIV(counter: number) {
		const iv = new ArrayBuffer(12);
		new DataView(iv).setUint32(8, counter);
		return new Uint8Array(iv);
	}
}
