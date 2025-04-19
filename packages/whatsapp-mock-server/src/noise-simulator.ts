import { create, fromBinary, protoInt64, toBinary } from "@bufbuild/protobuf";
import { NOISE_MODE, NOISE_WA_HEADER } from "@wha.ts/core/src/defaults";
import {
	CertChainSchema,
	CertChain_NoiseCertificate_DetailsSchema,
	ClientPayloadSchema,
	HandshakeMessageSchema,
} from "@wha.ts/proto";
import {
	bytesToHex,
	concatBytes,
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
import type { ServerWebSocket } from "bun";
import { addLengthPrefix } from "./frame-handler";
import type { MockNoiseState, MockWebSocketData } from "./types";

const logger = console;

const leafKeyPair: KeyPair = Curve.generateKeyPair();
// Key pair representing the mock Intermediate CA
const intermediateKeyPair: KeyPair = Curve.generateKeyPair();

const mockServerStaticPair = leafKeyPair;

type CertificateType = "intermediate" | "leaf";

/**
 * Generates certificate validity timestamps mimicking the observed WhatsApp pattern
 * for either intermediate or leaf certificates.
 *
 * - Intermediate: 2-year validity, anchored to July 1st, 21:00 UTC.
 * - Leaf: 126-day validity, based on a repeating cycle.
 *
 * @param type - The type of certificate ('intermediate' or 'leaf').
 * @returns An object with notBefore and notAfter timestamps as bigints (seconds since epoch).
 * @throws Error if an invalid type is provided.
 */
function generateWhaTSCertificateTimestamps(type: CertificateType): {
	notBefore: bigint;
	notAfter: bigint;
} {
	const nowMs = Date.now(); // Current time in milliseconds

	let notBeforeDate: Date;
	let notAfterDate: Date;

	const secondsPerDay = 24 * 60 * 60;
	const msPerDay = secondsPerDay * 1000;

	if (type === "intermediate") {
		const targetMonth = 6; // 0-indexed month for July
		const targetDay = 1;
		const targetHourUTC = 21;
		const validityYears = 2;

		const currentYear = new Date(nowMs).getUTCFullYear();

		// Find the next July 1st, 21:00 UTC >= now
		let expiryYear = currentYear;
		const potentialExpiryTimeThisYear = Date.UTC(
			expiryYear,
			targetMonth,
			targetDay,
			targetHourUTC,
			0,
			0,
			0,
		);

		if (nowMs >= potentialExpiryTimeThisYear) {
			expiryYear += 1;
		}

		notAfterDate = new Date(
			Date.UTC(expiryYear, targetMonth, targetDay, targetHourUTC, 0, 0, 0),
		);
		// Calculate notBefore (exactly 2 years prior)
		notBeforeDate = new Date(
			Date.UTC(
				expiryYear - validityYears,
				targetMonth,
				targetDay,
				targetHourUTC,
				0,
				0,
				0,
			),
		);
	} else if (type === "leaf") {
		const validityDays = 126;
		const validityMs = validityDays * msPerDay;

		// Reference start date from observed data (2025-01-13 21:00:00 UTC)
		const refStartMs = Date.UTC(2025, 0, 13, 21, 0, 0, 0); // Month is 0-indexed

		// Calculate how many full cycles have passed since the reference start
		const msSinceRefStart = nowMs - refStartMs;
		const cyclesPassed = Math.floor(msSinceRefStart / validityMs);

		// Calculate the start time of the current cycle
		const currentCycleStartMs = refStartMs + cyclesPassed * validityMs;
		const currentCycleEndMs = currentCycleStartMs + validityMs;

		notBeforeDate = new Date(currentCycleStartMs);
		notAfterDate = new Date(currentCycleEndMs);

		// Sanity check: ensure 'now' is within the calculated range
		if (nowMs < currentCycleStartMs || nowMs >= currentCycleEndMs) {
			console.warn(
				`[WARN] Current time ${new Date(nowMs).toISOString()} seems outside calculated leaf cycle: ${notBeforeDate.toISOString()} - ${notAfterDate.toISOString()}. Check logic or reference date.`,
			);
			// Adjusting to ensure 'now' is included - could indicate slight inaccuracies
			// in fixed cycle assumption or reference date. For mocking, ensuring 'now' is valid is key.
			const halfValidity = validityMs / 2;
			notBeforeDate = new Date(nowMs - halfValidity);
			notAfterDate = new Date(nowMs + halfValidity); // Center around now if cycle calculation seems off
		}
	} else {
		throw new Error(`Invalid certificate type: ${type}`);
	}

	// Convert final dates to Unix timestamps (seconds) and then to BigInt
	const notBeforeTs = Math.floor(notBeforeDate.getTime() / 1000);
	const notAfterTs = Math.floor(notAfterDate.getTime() / 1000);

	return {
		notBefore: BigInt(notBeforeTs),
		notAfter: BigInt(notAfterTs),
	};
}

const mockServerPayload = (() => {
	try {
		// --- Intermediate Certificate ---
		const intermediateCertTimestamps =
			generateWhaTSCertificateTimestamps("intermediate");
		const detailsIntermediate = create(
			CertChain_NoiseCertificate_DetailsSchema,
			{
				serial: 2, // Serial for the Intermediate Cert
				issuerSerial: 0, // Serial of the issuer (Root CA - dummy)
				key: intermediateKeyPair.publicKey, // Public key of the Intermediate CA
				notBefore: protoInt64.parse(intermediateCertTimestamps.notBefore), // Example timestamp
				notAfter: protoInt64.parse(intermediateCertTimestamps.notAfter), // Example timestamp
			},
		);
		const detailsIntermediateBytes = toBinary(
			CertChain_NoiseCertificate_DetailsSchema,
			detailsIntermediate,
		);
		// Sign intermediate details (using its own key as a stand-in for Root CA)
		const intermediateMsgToSign = concatBytes(
			new Uint8Array([6, 2]), // WhatsApp specific prefix for intermediate cert signing
			detailsIntermediateBytes,
		);
		// Technically should be signed by Root CA, using its own key here for mock purposes
		const intermediateSignature = Curve.sign(
			intermediateKeyPair.privateKey,
			intermediateMsgToSign,
		);
		const leafTimestamps = generateWhaTSCertificateTimestamps("leaf");
		// --- Leaf Certificate ---
		const detailsLeaf = create(CertChain_NoiseCertificate_DetailsSchema, {
			serial: 324, // Example serial for the Leaf Cert
			issuerSerial: 2, // Issuer is the Intermediate Cert
			key: leafKeyPair.publicKey, // Public key of the Server (Noise Static Key)
			notBefore: protoInt64.parse(leafTimestamps.notBefore), // Example timestamp
			notAfter: protoInt64.parse(leafTimestamps.notAfter), // Example timestamp
		});
		const detailsLeafBytes = toBinary(
			CertChain_NoiseCertificate_DetailsSchema,
			detailsLeaf,
		);
		// Sign leaf details using the Intermediate CA's private key
		const leafMsgToSign = concatBytes(
			new Uint8Array([6, 3]), // WhatsApp specific prefix for leaf cert signing
			detailsLeafBytes,
		);
		const leafSignature = Curve.sign(
			intermediateKeyPair.privateKey, // Signed by Intermediate CA
			leafMsgToSign,
		);

		// --- Construct CertChain ---
		// Ensure your CertChainSchema expects objects with { details, signature }
		const certChain = create(CertChainSchema, {
			intermediate: {
				details: detailsIntermediateBytes,
				signature: intermediateSignature,
			},
			leaf: {
				details: detailsLeafBytes,
				signature: leafSignature,
			},
		});
		console.log(detailsIntermediate);
		console.log(detailsLeaf);
		return toBinary(CertChainSchema, certChain);
	} catch (e) {
		logger.error("Failed to create mockServerPayload:", e);
		return new Uint8Array(0); // Fallback to empty payload on error
	}
})();

// Initialize the responder (server) state to match CLIENT's initial hash state logic.
// Client mixes Prologue + OWN Static Key initially.
// Server MUST calculate the initial hash without its own static key mixed in
// to ensure the AAD for the *first* encryption matches client expectation.
function initializeResponderNoiseState(
	prologue: Uint8Array,
	serverStaticPair: KeyPair,
): MockNoiseState {
	let handshakeHash = sha256(utf8ToBytes(NOISE_MODE));
	console.log(
		`[initializeResponderNoiseState] After protocol name: ${bytesToHex(
			handshakeHash,
		)}`,
	);
	handshakeHash = sha256(concatBytes(handshakeHash, prologue));
	console.log(
		`[initializeResponderNoiseState] After prologue: ${bytesToHex(
			handshakeHash,
		)}`,
	);
	const salt = handshakeHash;
	const cipherKey = handshakeHash;

	return {
		handshakeHash,
		salt,
		cipherKeyEncrypt: cipherKey,
		cipherKeyDecrypt: cipherKey,
		encryptNonce: 0n,
		decryptNonce: 0n,
		responderStaticPair: serverStaticPair,
	};
}

// KDF function - HKDF with specified salt and empty info
function kdf(
	keyMaterial: Uint8Array,
	salt: Uint8Array,
	outputBytes: number,
): Uint8Array {
	// Use HKDF-SHA256
	return hkdf(keyMaterial, outputBytes, { salt: salt, info: "" });
}

// MixKeys function - Updates Salt and Cipher Keys (Encrypt/Decrypt)
// Follows the Noise spec: CK, K = HKDF(CK, DH(...))
function mixKeys(
	state: MockNoiseState,
	inputKeyMaterial: Uint8Array,
): MockNoiseState {
	const hkdfResult = kdf(inputKeyMaterial, state.salt, 64); // 2 * HASHLEN (32)
	const newSalt = hkdfResult.subarray(0, 32);
	const newCipherKey = hkdfResult.subarray(32);

	return {
		...state,
		salt: newSalt,
		cipherKeyEncrypt: newCipherKey,
		cipherKeyDecrypt: newCipherKey,
		// Reset nonces whenever keys are mixed according to Noise spec A.3
		encryptNonce: 0n,
		decryptNonce: 0n,
	};
}

// Helper to generate IV/Nonce (12 bytes, last 8 are 64-bit counter BE)
// Uses Big Endian to match client's DataView default.
function generateIV(counter: bigint): Uint8Array {
	const iv = new Uint8Array(12);
	const view = new DataView(iv.buffer);
	const lower32bits = Number(counter & 0xffffffffn);
	view.setUint32(8, lower32bits, false); // Big Endian (matches client's default)
	// logger.debug(`[generateIV] counter=${counter}, lower32=${lower32bits}, endian=BE, resulting IV=${bytesToHex(iv)}`);
	return iv;
}

// Helper for mock encryption - uses current state, returns new state and ciphertext
function mockEncryptAndMix(
	state: MockNoiseState,
	plaintext: Uint8Array,
): { state: MockNoiseState; ciphertext: Uint8Array } {
	if (!state.cipherKeyEncrypt || state.cipherKeyEncrypt.length === 0) {
		throw new Error("Cannot encrypt: Cipher key not initialized");
	}
	const iv = generateIV(state.encryptNonce);
	logger.debug(
		`[mockEncryptAndMix] Encrypting ${plaintext.length} bytes. Nonce: ${
			state.encryptNonce
		}, IV: ${bytesToHex(iv)}, Key: ${bytesToHex(
			state.cipherKeyEncrypt.slice(0, 4),
		)}..., AAD(Hash): ${bytesToHex(state.handshakeHash.slice(0, 4))}...`,
	);
	// Use the current handshakeHash as AAD
	const ciphertext = aesEncryptGCM(
		plaintext,
		state.cipherKeyEncrypt, // Use encryption key
		iv,
		state.handshakeHash, // AAD is current hash *before* mixing ciphertext
	);

	// Increment nonce AFTER successful encryption
	const nextNonce = state.encryptNonce + 1n;
	if (nextNonce >= 2n ** 64n) {
		throw new Error("Nonce overflow during encryption");
	}

	// Mix the *ciphertext* into the hash AFTER encryption
	const newHandshakeHash = sha256(concatBytes(state.handshakeHash, ciphertext));
	logger.debug(
		`[mockEncryptAndMix] Hash after mixing ciphertext: ${bytesToHex(
			newHandshakeHash.slice(0, 8),
		)}...`,
	);

	// Return new state with incremented nonce and updated hash
	return {
		state: {
			...state,
			encryptNonce: nextNonce,
			handshakeHash: newHandshakeHash,
		},
		ciphertext,
	};
}

// Helper for mock decryption - uses current state, returns new state and plaintext
function mockDecryptAndMix(
	state: MockNoiseState,
	ciphertext: Uint8Array,
): { state: MockNoiseState; plaintext: Uint8Array } {
	if (!state.cipherKeyDecrypt || state.cipherKeyDecrypt.length === 0) {
		throw new Error("Cannot decrypt: Cipher key not initialized");
	}
	const iv = generateIV(state.decryptNonce);
	logger.debug(
		`[mockDecryptAndMix] Decrypting ${ciphertext.length} bytes. Nonce: ${
			state.decryptNonce
		}, IV: ${bytesToHex(iv)}, Key: ${bytesToHex(
			state.cipherKeyDecrypt.slice(0, 4),
		)}..., AAD(Hash): ${bytesToHex(state.handshakeHash.slice(0, 4))}...`,
	);

	// Use the current handshakeHash as AAD
	let plaintext: Uint8Array;
	try {
		plaintext = aesDecryptGCM(
			ciphertext,
			state.cipherKeyDecrypt, // Use decryption key
			iv,
			state.handshakeHash, // AAD is current hash *before* mixing ciphertext
		);
	} catch (e) {
		logger.error(
			`[mockDecryptAndMix] AES-GCM Decryption failed: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
		throw e; // Re-throw after logging
	}

	// Increment nonce AFTER successful decryption
	const nextNonce = state.decryptNonce + 1n;
	if (nextNonce >= 2n ** 64n) {
		throw new Error("Nonce overflow during decryption");
	}

	// Mix the *ciphertext* into the hash AFTER decryption
	const newHandshakeHash = sha256(concatBytes(state.handshakeHash, ciphertext));
	logger.debug(
		`[mockDecryptAndMix] Hash after mixing ciphertext: ${bytesToHex(
			newHandshakeHash.slice(0, 8),
		)}...`,
	);

	// Return new state with incremented nonce and updated hash
	return {
		state: {
			...state,
			decryptNonce: nextNonce,
			handshakeHash: newHandshakeHash,
		},
		plaintext,
	};
}

export function handleNoiseHandshakeMessage(
	ws: ServerWebSocket<MockWebSocketData>,
	messageFrame: Uint8Array, // Frame *after* 3-byte length prefix
): boolean {
	logger.debug(
		`[handleNoiseHandshakeMessage] Entered. Frame length: ${
			messageFrame.length
		}. State: ${ws.data.state}. Hex: ${bytesToHex(
			messageFrame.slice(0, 10),
		)}...`,
	);

	const data = ws.data;
	if (data.state !== "handshaking") {
		logger.warn(
			`[handleNoiseHandshakeMessage] Called in wrong state: ${data.state}`,
		);
		return false;
	}

	const protobufPayload = messageFrame;

	try {
		const handshakeMsg = fromBinary(HandshakeMessageSchema, protobufPayload);
		logger.info(
			`[${data.sessionId}] Successfully decoded Protobuf HandshakeMessage.`,
		);

		let mockState = data.noiseState; // Get current state or undefined

		if (handshakeMsg.clientHello?.ephemeral) {
			// --- Processing ClientHello (Initiator: -> e) ---
			// Responder receives ClientHello
			// -----------------------------------------------

			if (mockState) {
				logger.warn(
					`[${data.sessionId}] Received ClientHello but noise state already exists. Reinitializing.`,
				);
			}
			logger.info(
				`[${data.sessionId}] Processing ClientHello (Noise XX Spec Simulation)...`,
			);
			const clientEphemeralPublic = handshakeMsg.clientHello.ephemeral;

			// 1. Initialize responder noise state (h = HASH(MODE || prologue))
			//    Pass static key separately for later use in DH.
			mockState = initializeResponderNoiseState(
				NOISE_WA_HEADER,
				mockServerStaticPair, // Pass static key for DH use later
			);
			// Hash state does NOT include server static key at this point.

			// 2. Store client ephemeral for DH. Do not mix into hash state yet.
			const clientEphemeralForDH = clientEphemeralPublic;
			logger.debug(
				`[${data.sessionId}] Received client ephemeral (re). Stored for DH.`,
			);

			// --- Start preparing ServerHello (Responder: <- e, ee, s, es) ---

			// 3. Generate server's ephemeral key pair
			const serverEphemeralPair = Curve.generateKeyPair();
			mockState.responderEphemeralPair = serverEphemeralPair;
			logger.debug(`[${data.sessionId}] Generated server ephemeral key pair.`);

			// 4. Mix server's ephemeral public key into hash: H = HASH(h || e)
			//    Client expects this mix before decrypting serverHello.static
			mockState.handshakeHash = sha256(
				concatBytes(mockState.handshakeHash, serverEphemeralPair.publicKey),
			);
			logger.debug(
				`[${
					data.sessionId
				}] Mixed server ephemeral (e) into hash. Hash: ${bytesToHex(
					mockState.handshakeHash.slice(0, 8),
				)}...`,
			);

			// 5. Perform DH: DH(e, re) -> DH(server_ephemeral, client_ephemeral)
			const dh_ee = Curve.sharedKey(
				serverEphemeralPair.privateKey,
				clientEphemeralForDH, // Use the stored client ephemeral key
			);
			// Mix Keys based on dh_ee -> k1
			mockState = mixKeys(mockState, dh_ee); // Nonce resets to 0
			logger.debug(`[${data.sessionId}] Mixed keys from DH(e, re).`);

			// 6. Encrypt server's static public key (s)
			// Uses key 'k1', nonce 0, and AAD = current hash (H(MODE||prologue||e))
			if (!mockState.responderStaticPair) {
				throw new Error(
					"Internal error: responderStaticPair missing in state for encryption.",
				);
			}
			const encryptStaticResult = mockEncryptAndMix(
				mockState,
				mockState.responderStaticPair.publicKey,
			);
			// mockEncryptAndMix updates hash with ciphertext c1: h = HASH(h || c1)
			// and increments nonce to 1
			mockState = encryptStaticResult.state;
			const encryptedServerStatic = encryptStaticResult.ciphertext;
			logger.debug(
				`[${data.sessionId}] Encrypted server static key (s). Hash updated.`,
			);

			// 7. Perform DH: DH(s, re) -> DH(server_static, client_ephemeral)
			if (!mockState.responderStaticPair) {
				throw new Error(
					"Internal error: responderStaticPair missing in state for DH.",
				);
			}
			const dh_es = Curve.sharedKey(
				mockState.responderStaticPair.privateKey, // Use stored static private key
				clientEphemeralForDH, // Use the stored client ephemeral key
			);
			// Mix Keys based on dh_es -> k2
			mockState = mixKeys(mockState, dh_es); // Nonce resets to 0
			logger.debug(`[${data.sessionId}] Mixed keys from DH(s, re).`);

			// 8. Encrypt payload
			// Uses key 'k2', nonce 0, and AAD = current hash (H(MODE||prologue||e||c1))
			const encryptPayloadResult = mockEncryptAndMix(
				mockState,
				mockServerPayload,
			);
			// mockEncryptAndMix updates hash with ciphertext c2: h = HASH(h || c2)
			// and increments nonce to 1
			mockState = encryptPayloadResult.state;
			const encryptedPayload = encryptPayloadResult.ciphertext;
			logger.debug(`[${data.sessionId}] Encrypted payload. Hash updated.`);

			// --- Construct and Send ServerHello ---
			const serverHelloMsg = create(HandshakeMessageSchema, {
				serverHello: {
					ephemeral: serverEphemeralPair.publicKey, // Send cleartext server ephemeral
					static: encryptedServerStatic, // Send encrypted server static
					payload: encryptedPayload, // Send encrypted payload
				},
			});
			const serverHelloBytes = toBinary(HandshakeMessageSchema, serverHelloMsg);
			const serverHelloFrame = addLengthPrefix(serverHelloBytes);
			const finalFrameLen = serverHelloFrame.length;

			logger.info(
				`[${data.sessionId}] Sending ServerHello (Noise XX Spec)... Proto Length: ${serverHelloBytes.length}, Final Frame Length: ${finalFrameLen}`,
			);
			const bytesSent = ws.sendBinary(serverHelloFrame);
			logger.debug(
				`[${data.sessionId}] ws.sendBinary for ServerHello returned: ${bytesSent}`,
			);
			if (bytesSent <= 0) {
				logger.warn(
					`[${data.sessionId}] Failed to send ServerHello (returned ${bytesSent}).`,
				);
			}

			// Store the updated noise state, ready for ClientFinish
			data.noiseState = mockState;
			logger.debug(
				`[${data.sessionId}] ClientHello processed, ServerHello sent. Mock Noise state updated.`,
			);
			return true; // Handshake step successful, waiting for next message
		}

		if (
			handshakeMsg.clientFinish?.static &&
			handshakeMsg.clientFinish?.payload
		) {
			// --- Processing ClientFinish (Initiator: -> s, se) ---
			// Responder receives ClientFinish
			// ---------------------------------------------------
			logger.info(
				`[${data.sessionId}] Processing ClientFinish (Noise XX Spec Simulation)...`,
			);
			if (!mockState || !mockState.responderStaticPair) {
				// Need static pair for DH(e,s)
				logger.error(
					`[${data.sessionId}] Received ClientFinish but noise state is missing or incomplete!`,
				);
				ws.close(1011, "Internal server error: noise state missing");
				return false;
			}

			// 1. Decrypt client's static public key (s)
			// AAD = current hash (H(...||c1||c2)); Nonce = 0 (reset by mixKeys(dh_es))
			const decryptStaticResult = mockDecryptAndMix(
				mockState,
				handshakeMsg.clientFinish.static,
			);
			mockState = decryptStaticResult.state; // Updates hash and increments nonce to 1
			const clientStaticPublic = decryptStaticResult.plaintext;
			mockState.initiatorStaticPublicKey = clientStaticPublic; // Store for later use
			logger.debug(
				`[${data.sessionId}] Decrypted client static public key (s). Hash updated.`,
			);

			// 2. Perform DH: DH(e, s) -> DH(server_ephemeral, client_static)
			if (!mockState.responderEphemeralPair) {
				logger.error(
					`[${data.sessionId}] Missing server ephemeral key pair for DH(e, s).`,
				);
				ws.close(1011, "Internal server error: state inconsistent");
				return false;
			}
			const dh_se = Curve.sharedKey(
				mockState.responderEphemeralPair.privateKey,
				clientStaticPublic,
			);
			// Mix Keys based on dh_se -> k3
			mockState = mixKeys(mockState, dh_se); // Nonce resets to 0
			logger.debug(`[${data.sessionId}] Mixed keys from DH(e, s).`);

			// 3. Decrypt client payload
			// AAD = current hash (H(...||c1||c2||c3_static)); Nonce = 0 (reset by mixKeys(dh_se))
			const decryptPayloadResult = mockDecryptAndMix(
				mockState,
				handshakeMsg.clientFinish.payload,
			);
			mockState = decryptPayloadResult.state; // Updates hash and increments nonce to 1
			const clientPayload = decryptPayloadResult.plaintext; // Payload usually contains auth details
			logger.debug(
				`[${data.sessionId}] Decrypted client payload. Hash updated.`,
			);

			// Optionally decode/validate clientPayload
			try {
				const decodedClientPayload = fromBinary(
					ClientPayloadSchema,
					clientPayload,
				);
				logger.info(
					`[${data.sessionId}] Successfully decoded ClientFinish payload: Username=${decodedClientPayload.username}, Type=${decodedClientPayload.connectType}`,
				);
			} catch (payloadError) {
				logger.warn(
					`[${
						data.sessionId
					}] Could not decode ClientFinish payload as ClientPayload protobuf: ${
						payloadError instanceof Error ? payloadError.message : payloadError
					}`,
				);
			}

			// 4. Handshake Complete - Derive transport keys (Split)
			const finalOkm = kdf(new Uint8Array(0), mockState.salt, 64);
			const finalDecryptKey = finalOkm.subarray(0, 32); // Server Decrypts (Client Sends)
			const finalEncryptKey = finalOkm.subarray(32); // Server Encrypts (Client Receives)

			mockState.cipherKeyEncrypt = finalEncryptKey;
			mockState.cipherKeyDecrypt = finalDecryptKey;
			mockState.encryptNonce = 0n; // Reset nonces for transport phase
			mockState.decryptNonce = 0n;
			mockState.handshakeHash = new Uint8Array(); // Hash is no longer used/needed

			logger.debug(
				`[${
					data.sessionId
				}] Finalized mock noise keys for transport. EncKey: ${bytesToHex(
					mockState.cipherKeyEncrypt.slice(0, 8),
				)}..., DecKey: ${bytesToHex(mockState.cipherKeyDecrypt.slice(0, 8))}...`,
			);

			data.noiseState = mockState; // Store final state

			logger.info(`[${data.sessionId}] Noise Handshake Complete (Simulated)`);
			data.state = "handshake_complete"; // Transition state
			logger.debug(`[${data.sessionId}] State updated to handshake_complete.`);
			return true; // Handshake successful
		}

		logger.warn(
			`[${
				data.sessionId
			}] Received unexpected handshake message type: ${JSON.stringify(
				handshakeMsg,
			)}`,
		);
		ws.close(1002, "Unexpected handshake message type");
		return false;
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger.error(
			`[${data.sessionId}] Error processing handshake message (protobuf payload length: ${protobufPayload.length}): ${err.message}`,
			err.stack, // Include stack trace
		);
		logger.error(
			`[${data.sessionId}] Protobuf Payload Hex (start): ${bytesToHex(
				protobufPayload.slice(0, 20),
			)}`,
		);
		ws.close(1002, `Handshake error: ${err.message}`);
		return false;
	}
}
