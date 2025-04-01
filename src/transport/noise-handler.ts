import { Buffer } from "buffer";
import {
  generateX25519KeyPair,
  computeX25519SharedSecret,
  sha256,
  hkdfSha256,
  aesGcmEncrypt,
  aesGcmDecrypt,
  generateAesGcmNonce,
} from "../signal/crypto";
import {
  ClientPayloadSchema,
  HandshakeMessageSchema,
  type ClientPayload,
  type HandshakeMessage,
} from "../gen/whatsapp_pb";
import type { ILogger } from "./types";
import { NOISE_WA_HEADER, NOISE_MODE } from "../defaults"; // Import constants
import { create, toBinary } from "@bufbuild/protobuf";
import type { KeyPair } from "../state/interface";

const PROTOCOL_NAME = Buffer.from(NOISE_MODE); // e.g., "Noise_XX_25519_AESGCM_SHA256"
const PROLOGUE = NOISE_WA_HEADER; // e.g., "WA" + Binary Version + Proto Version

interface NoiseState {
  hash: Uint8Array; // h
  chainingKey: Uint8Array; // ck
  sendKey: Uint8Array | null; // k_send
  recvKey: Uint8Array | null; // k_recv
  sendNonce: number; // n_send
  recvNonce: number; // n_recv
}

interface NoiseHandshakeState extends NoiseState {
  staticKeypair: KeyPair; // s
  ephemeralKeypair: KeyPair; // e
  remoteStaticPub: Uint8Array | null; // rs
  remoteEphemeralPub: Uint8Array | null; // re
  preSharedKey?: Uint8Array; // psk (optional, not used in WA default XX)
  initiator: boolean;
}

export class NoiseHandler {
  private state: NoiseHandshakeState | NoiseState | null = null;
  private isHandshakeComplete: boolean = false;
  private logger: ILogger;
  private staticKeypair: KeyPair; // Permanent static keys for the session lifetime
  private inBytes = Buffer.alloc(0); // Buffer for partial frames
  private sentIntro = false;

  constructor(
    initialStaticKeypair: KeyPair,
    logger: ILogger,
    private routingInfo?: Buffer
  ) {
    this.logger = logger;
    this.staticKeypair = initialStaticKeypair;
    this.initializeHandshake();
  }

  private initializeHandshake(): void {
    const hashOutputSize = 32; // SHA256
    const ck = Buffer.alloc(hashOutputSize);
    const h = Buffer.alloc(hashOutputSize);

    if (PROTOCOL_NAME.length <= hashOutputSize) {
      PROTOCOL_NAME.copy(ck);
      PROTOCOL_NAME.copy(h);
    } else {
      const digest = Buffer.from(sha256(PROTOCOL_NAME));
      digest.copy(ck);
      digest.copy(h);
    }

    this.state = {
      hash: h,
      chainingKey: ck,
      sendKey: null,
      recvKey: null,
      sendNonce: 0,
      recvNonce: 0,
      staticKeypair: this.staticKeypair,
      ephemeralKeypair: generateX25519KeyPair(),
      remoteStaticPub: null,
      remoteEphemeralPub: null,
      initiator: true, // Client is always initiator in this context
    };
    this.isHandshakeComplete = false;
    this.sentIntro = false;
    this.inBytes = Buffer.alloc(0);

    this.logger.info("Noise handshake initialized");
    this.mixHash(PROLOGUE);
  }

  private mixHash(data: Uint8Array): void {
    if (!this.state) throw new Error("Noise state not initialized");
    const input = Buffer.concat([this.state.hash, data]);
    this.state.hash = sha256(input);
  }

  private async mixKey(data: Uint8Array): Promise<void> {
    if (!this.state) throw new Error("Noise state not initialized");
    const output = await hkdfSha256(data, 64, {
      salt: this.state.chainingKey,
      info: Buffer.from("Noise XXWhatsApp"),
    });
    this.state.chainingKey = output.slice(0, 32);
    const newKeyMaterial = output.slice(32);

    // If we have a key, it means we need to initialize the CipherState
    if (newKeyMaterial.length > 0) {
      this.state.sendKey = newKeyMaterial;
      this.state.sendNonce = 0;
    } else {
      // Handle cases where no new key is derived if necessary
      this.state.sendKey = null; // Or keep the old one depending on the Noise pattern step
    }
    // In XX, recvKey is typically set after processing the server's message
    this.logger.trace("Mixed key into state");
  }

  // Encrypts data using the current send key and nonce
  private encryptWithAd(plaintext: Uint8Array, ad?: Uint8Array): Uint8Array {
    if (!this.state?.sendKey) {
      throw new Error("Handshake not advanced enough to encrypt");
    }
    const iv = generateAesGcmNonce(this.state.sendNonce++);
    const ciphertext = aesGcmEncrypt(
      plaintext,
      this.state.sendKey,
      iv,
      ad || this.state.hash
    );
    this.mixHash(ciphertext); // Mix ciphertext into hash after encryption
    return ciphertext;
  }

  // Decrypts data using the current receive key and nonce
  private decryptWithAd(ciphertext: Uint8Array, ad?: Uint8Array): Uint8Array {
    if (!this.state?.recvKey) {
      throw new Error("Handshake not advanced enough to decrypt");
    }
    const iv = generateAesGcmNonce(this.state.recvNonce++);
    const plaintext = aesGcmDecrypt(
      ciphertext,
      this.state.recvKey,
      iv,
      ad || this.state.hash
    );
    this.mixHash(ciphertext); // Mix ciphertext into hash after decryption
    return plaintext;
  }

  // --- Handshake Processing ---

  // Message Pattern: -> e
  public async generateInitialHandshakeMessage(): Promise<Buffer> {
    if (!this.state || !("ephemeralKeypair" in this.state))
      throw new Error("Invalid state for ClientHello");
    const { ephemeralKeypair } = this.state;

    this.mixHash(ephemeralKeypair.public); // h = SHA256(h || e.public)

    const initialHandshakeMessage = create(HandshakeMessageSchema, {
      clientHello: {
        ephemeral: ephemeralKeypair.public,
      },
    });

    const payloadProto = toBinary(
      HandshakeMessageSchema,
      initialHandshakeMessage
    );

    this.logger.info("Generated initial ClientHello");
    return Buffer.from(payloadProto); // No encryption yet
  }

  // Message Pattern: <- e, ee, s, es
  public async processServerHello({
    serverHello,
  }: HandshakeMessage): Promise<void> {
    if (
      !this.state ||
      !("ephemeralKeypair" in this.state) ||
      this.isHandshakeComplete
    ) {
      throw new Error("Invalid state for processing ServerHello");
    }
    const { ephemeralKeypair } = this.state;

    if (!serverHello?.ephemeral)
      throw new Error("ServerHello missing ephemeral key");

    this.state.remoteEphemeralPub = Buffer.from(serverHello.ephemeral);

    this.mixHash(this.state.remoteEphemeralPub); // h = SHA256(h || re.public)

    // Calculate shared secrets and mix keys
    const dh_ee = computeX25519SharedSecret(
      ephemeralKeypair.private,
      Buffer.from(this.state.remoteEphemeralPub)
    );
    await this.mixKey(dh_ee); // ck, k = HKDF(cd, dh(e, re))

    // Decrypt static key (s)
    if (!serverHello.static)
      throw new Error("ServerHello missing static key payload");
    const remoteStaticPubPlain = this.decryptWithAd(serverHello.static); // p = Decrypt(k, n=0, h, rs_ciphertext)
    this.state.remoteStaticPub = remoteStaticPubPlain;
    this.mixHash(serverHello.static); // Mix the *ciphertext* not plaintext

    // Calculate shared secret and mix key
    const dh_es = computeX25519SharedSecret(
      ephemeralKeypair.private,
      this.state.remoteStaticPub
    );
    await this.mixKey(dh_es); // ck, k = HKDF(ck, dh(e, rs))

    // Decrypt final payload (cert chain etc.)
    if (!serverHello.payload) throw new Error("ServerHello missing payload");
    const serverPayloadPlain = this.decryptWithAd(serverHello.payload); // p = Decrypt(k, n=1, h, payload_ciphertext)
    this.mixHash(serverHello.payload); // Mix the *ciphertext*

    // Swap keys for the next stage (send=recv, recv=send) - Important!
    // We derived sendKey twice, the second one is for receiving server's next message
    this.state.recvKey = this.state.sendKey;
    this.state.recvNonce = 0;
    // Send key needs to be derived in the next step (ClientFinish)

    this.logger.info("Processed ServerHello");

    // TODO: Process the serverPayloadPlain (CertChain verification)
    // For now, just logging it
    this.logger.debug(
      { serverPayloadSize: serverPayloadPlain.length },
      "Decrypted server payload"
    );
    // const certChain = CertChain.fromBinary(serverPayloadPlain); // Assuming CertChain proto exists
    // verifyCertChain(certChain); // Implement this
  }

  // Message Pattern: -> s, se, p
  public async generateClientFinish(
    clientPayload: ClientPayload
  ): Promise<Uint8Array> {
    if (
      !this.state ||
      !("staticKeypair" in this.state) ||
      !this.state.remoteStaticPub ||
      this.isHandshakeComplete
    ) {
      throw new Error("Invalid state for ClientFinish");
    }
    const { staticKeypair } = this.state;

    // Encrypt static key
    const staticCiphertext = this.encryptWithAd(staticKeypair.public); // c = Encrypt(k, n=0, h, s.public)

    // Calculate shared secret and mix key
    const dh_se = computeX25519SharedSecret(
      staticKeypair.private,
      this.state.remoteEphemeralPub!
    );
    await this.mixKey(dh_se); // ck, k = HKDF(ck, dh(s, re))

    // Encrypt final payload
    const clientPayloadBytes = toBinary(ClientPayloadSchema, clientPayload);
    const payloadCiphertext = this.encryptWithAd(clientPayloadBytes); // c = Encrypt(k, n=1, h, client_payload)

    const clientFinish: Partial<HandshakeMessage["clientFinish"]> = {
      static: staticCiphertext,
      payload: payloadCiphertext,
    };

    const handshakeMsg = create(HandshakeMessageSchema, {
      clientFinish: clientFinish,
    });
    this.logger.info("Generated ClientFinish");

    return toBinary(HandshakeMessageSchema, handshakeMsg);
  }

  // Call after ClientFinish is sent and Server ACK (implicitly) received
  public finishHandshake(): void {
    if (
      this.isHandshakeComplete ||
      !this.state?.sendKey ||
      !this.state.recvKey
    ) {
      this.logger.warn(
        "Cannot finish handshake, state invalid or already complete"
      );
      return;
    }

    // Final key derivation for transport phase (XX pattern specific)
    const finalSendKey = this.state.sendKey;
    const finalRecvKey = this.state.recvKey;

    this.state = {
      hash: this.state.hash, // Keep the final hash if needed by protocol
      chainingKey: this.state.chainingKey, // Keep final chaining key if needed
      sendKey: finalSendKey,
      recvKey: finalRecvKey,
      sendNonce: 0, // Reset nonces for transport phase
      recvNonce: 0,
    };
    this.isHandshakeComplete = true;
    this.logger.info("Noise handshake complete, switched to transport mode");
  }

  // --- Transport Phase ---

  public encryptFrame(plaintext: Uint8Array): Uint8Array {
    if (!this.isHandshakeComplete || !this.state?.sendKey) {
      throw new Error("Cannot encrypt, handshake not complete");
    }
    const iv = generateAesGcmNonce(this.state.sendNonce++);
    // No AD in transport phase for WhatsApp? Check specifics. Typically AD is empty.
    return aesGcmEncrypt(plaintext, this.state.sendKey, iv);
  }

  public decryptFrame(ciphertext: Uint8Array): Uint8Array {
    if (!this.isHandshakeComplete || !this.state?.recvKey) {
      throw new Error("Cannot decrypt, handshake not complete");
    }
    const iv = generateAesGcmNonce(this.state.recvNonce++);
    // No AD in transport phase for WhatsApp?
    return aesGcmDecrypt(ciphertext, this.state.recvKey, iv);
  }

  // --- Framing ---

  // Adds WA's length prefix and potentially the Noise header + routing info
  public encodeFrame(data: Uint8Array): Uint8Array {
    const isEncrypted = this.isHandshakeComplete;
    const payload = isEncrypted ? this.encryptFrame(data) : data;

    const headerParts: Uint8Array[] = [];

    if (!this.sentIntro) {
      if (this.routingInfo) {
        const routingHeader = Buffer.alloc(7);
        routingHeader.write("ED", 0, "utf8");
        routingHeader.writeUInt8(0, 2); // Fixed bytes
        routingHeader.writeUInt8(1, 3); // Fixed bytes
        routingHeader.writeUInt8(this.routingInfo.byteLength >> 16, 4); // Top 8 bits of length
        routingHeader.writeUInt16BE(this.routingInfo.byteLength & 0xffff, 5); // Lower 16 bits of length
        headerParts.push(routingHeader, this.routingInfo);
      }
      headerParts.push(PROLOGUE); // Add WA header
      this.sentIntro = true;
      this.logger.trace("Prepended Noise header");
    }

    const headerLength = headerParts.reduce((sum, b) => sum + b.length, 0);
    const frameLengthBytes = 3;
    const totalLength = headerLength + frameLengthBytes + payload.length;
    const frame = Buffer.alloc(totalLength);
    let offset = 0;

    // Write Headers
    for (const part of headerParts) {
      frame.set(part, offset);

      offset += part.length;
    }

    // Write Length (3 bytes, Big Endian)
    if (payload.length >= 1 << 24) {
      throw new Error("Frame too large for 3-byte length prefix");
    }
    frame.writeUInt8((payload.length >> 16) & 0xff, offset++); // MSB
    frame.writeUInt16BE(payload.length & 0xffff, offset); // Remaining 2 bytes
    offset += 2;

    // Write Payload
    frame.set(payload, offset);

    this.logger.trace(
      { frameLen: payload.length, isEncrypted },
      "Encoded frame for sending"
    );
    return frame;
  }

  // Processes incoming framed data, handles buffering, decryption, and emits decoded frames
  public decodeFrame(
    newData: Uint8Array,
    onFrameDecrypted: (decryptedPayload: Uint8Array) => void // Callback for each fully decrypted frame payload
  ): void {
    this.inBytes = Buffer.concat([this.inBytes, newData]);
    this.logger.trace(
      `Received ${newData.length} bytes, total buffer ${this.inBytes.length}`
    );

    while (true) {
      const frameLength =
        (this.inBytes.readUint8() << 16) | this.inBytes.readUInt16BE(1);
      const totalFrameLength = 3 + frameLength;

      if (this.inBytes.length < totalFrameLength) {
        this.logger.warn(
          { frameLen: frameLength, remainingBuffer: this.inBytes.length },
          "Incomplete frame, waiting for more data"
        );
        break;
      }

      // Extract the frame payload (encrypted or handshake)
      const framePayload = this.inBytes.subarray(3, totalFrameLength);
      this.inBytes = this.inBytes.subarray(totalFrameLength); // Consume frame

      this.logger.trace(
        { frameLen: frameLength, remainingBuffer: this.inBytes.length },
        "Extracted raw frame payload"
      );

      try {
        let decryptedFrameData: Uint8Array;
        if (this.isHandshakeComplete) {
          decryptedFrameData = this.decryptFrame(framePayload);
          this.logger.trace("Decrypted transport frame");
        } else {
          // Handshake messages are Protobuf, but Noise handles the crypto layer only
          // Pass the raw payload up. Handshake processing logic outside NoiseHandler will decode the protobuf.
          decryptedFrameData = framePayload;
          this.logger.trace("Passing through raw handshake frame payload");
        }

        // *** EMIT RAW DECRYPTED PAYLOAD ***
        onFrameDecrypted(decryptedFrameData);
      } catch (err: any) {
        this.logger.error(
          { err },
          "Error decrypting/processing received frame payload"
        );
        // Handle error appropriately - maybe emit an error event or close connection
      }
    } // end while
  } // end decodeFrame
}
