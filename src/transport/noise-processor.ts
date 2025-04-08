import {
  aesDecryptGCM,
  aesEncryptGCM,
  Curve,
  hkdf,
  sha256,
} from "../signal/crypto";
import type { KeyPair } from "../state/interface";
import type { ILogger } from "./types";
import { NOISE_MODE, WA_CERT_DETAILS } from "../defaults";
import { concatBytes, utf8ToBytes } from "../utils/bytes-utils";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  CertChain_NoiseCertificate_DetailsSchema,
  CertChainSchema,
  HandshakeMessageSchema,
} from "../gen/whatsapp_pb";

interface NoiseState {
  handshakeHash: Uint8Array;
  salt: Uint8Array;
  encryptionKey: Uint8Array;
  decryptionKey: Uint8Array;
  readCounter: number;
  writeCounter: number;
  isHandshakeFinished: boolean;
  hasSentPrologue: boolean;
  receivedBytes: Uint8Array;
  routingInfo?: Uint8Array;
  noisePrologue: Uint8Array;
  logger: ILogger;
}

export class NoiseProcessor {
  private state: NoiseState;

  constructor({
    staticKeyPair,
    noisePrologue,
    logger,
    routingInfo,
  }: {
    staticKeyPair: KeyPair;
    noisePrologue: Uint8Array;
    logger: ILogger;
    routingInfo?: Uint8Array;
  }) {
    const initialHashData = utf8ToBytes(NOISE_MODE);
    let handshakeHash = initialHashData.byteLength === 32
      ? initialHashData
      : sha256(initialHashData);
    const salt = handshakeHash;
    const encryptionKey = handshakeHash;
    const decryptionKey = handshakeHash;

    handshakeHash = sha256(concatBytes(handshakeHash, noisePrologue));
    handshakeHash = sha256(
      concatBytes(handshakeHash, staticKeyPair.public),
    );

    this.state = {
      handshakeHash,
      salt,
      encryptionKey,
      decryptionKey,
      readCounter: 0,
      writeCounter: 0,
      isHandshakeFinished: false,
      hasSentPrologue: false,
      receivedBytes: new Uint8Array(0),
      routingInfo,
      noisePrologue,
      logger,
    };
  }

  getState(): NoiseState {
    return this.state;
  }

  generateInitialHandshakeMessage(ephemeralKeyPair: KeyPair): Uint8Array {
    const helloMsg = create(HandshakeMessageSchema, {
      clientHello: {
        ephemeral: ephemeralKeyPair.public,
      },
    });
    return toBinary(HandshakeMessageSchema, helloMsg);
  }

  private mixIntoHandshakeHash(data: Uint8Array) {
    if (!this.state.isHandshakeFinished) {
      this.state = {
        ...this.state,
        handshakeHash: sha256(
          concatBytes(this.state.handshakeHash, data),
        ),
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
    serverHelloData: Uint8Array,
    localStaticKeyPair: KeyPair,
    localEphemeralKeyPair: KeyPair,
  ) {
    const { serverHello } = fromBinary(HandshakeMessageSchema, serverHelloData);
    if (
      !serverHello?.ephemeral || !serverHello?.static || !serverHello?.payload
    ) {
      throw new Error("Invalid serverHello message received");
    }
    this.mixIntoHandshakeHash(serverHello.ephemeral);
    await this.mixKeys(
      Curve.sharedKey(localEphemeralKeyPair.private, serverHello.ephemeral),
    );
    const decryptedServerStatic = await this.decryptMessage(serverHello.static);
    await this.mixKeys(
      Curve.sharedKey(localEphemeralKeyPair.private, decryptedServerStatic),
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
      this.state.logger.error({
        expected: WA_CERT_DETAILS.SERIAL,
        received: issuerSerial,
      }, "Certificate serial mismatch");
      throw new Error(
        `Server certificate validation failed. Expected serial ${WA_CERT_DETAILS.SERIAL}, received ${issuerSerial}`,
      );
    }
    const encryptedLocalStaticPublic = await this.encryptMessage(
      localStaticKeyPair.public,
    );
    await this.mixKeys(
      Curve.sharedKey(localStaticKeyPair.private, serverHello.ephemeral),
    );
    return encryptedLocalStaticPublic;
  }

  async encodeFrame(data: Uint8Array) {
    let encryptedData: Uint8Array;
    if (this.state.isHandshakeFinished) {
      encryptedData = await this.encryptMessage(data);
    } else {
      encryptedData = data;
    }
    let frameHeader: Uint8Array = new Uint8Array(0);
    if (!this.state.hasSentPrologue) {
      if (this.state.routingInfo) {
        const headerPrefix = new Uint8Array(7);
        const view = new DataView(headerPrefix.buffer);
        headerPrefix.set([..."ED"].map((c) => c.charCodeAt(0)), 0);
        view.setUint8(2, 0);
        view.setUint8(3, 1);
        view.setUint8(4, this.state.routingInfo.byteLength >> 16);
        view.setUint16(5, this.state.routingInfo.byteLength & 0xffff, false);
        frameHeader = concatBytes(
          headerPrefix,
          this.state.routingInfo,
          this.state.noisePrologue,
        );
      } else {
        frameHeader = this.state.noisePrologue;
      }
      this.state.hasSentPrologue = true;
    }
    const totalLength = frameHeader.length + 3 + encryptedData.length;
    const frame = new Uint8Array(totalLength);
    frame.set(frameHeader, 0);
    const view = new DataView(
      frame.buffer,
      frameHeader.byteOffset + frameHeader.length,
      3,
    );
    view.setUint8(0, encryptedData.length >> 16);
    view.setUint16(1, encryptedData.length & 0xffff, false);
    frame.set(encryptedData, frameHeader.length + 3);
    return frame;
  }

  async decodeFrame(
    newData: Uint8Array,
    onFrame: (frameData: Uint8Array) => void,
  ) {
    this.state = {
      ...this.state,
      receivedBytes: concatBytes(this.state.receivedBytes, newData),
    };
    while (this.state.receivedBytes.length >= 3) {
      const dataView = new DataView(
        this.state.receivedBytes.buffer,
        this.state.receivedBytes.byteOffset,
        this.state.receivedBytes.byteLength,
      );
      const frameLength = (dataView.getUint8(0) << 16) |
        dataView.getUint16(1, false);
      if (this.state.receivedBytes.length >= frameLength + 3) {
        const frameContentBytes = this.state.receivedBytes.subarray(
          3,
          frameLength + 3,
        );
        const remainingBytes = this.state.receivedBytes.subarray(
          frameLength + 3,
        );
        let processedFrameContent: Uint8Array;
        if (this.state.isHandshakeFinished) {
          try {
            processedFrameContent = await this.decryptMessage(
              frameContentBytes,
            );
          } catch (error) {
            this.state.logger.error({ err: error }, "Error decrypting frame");
            this.state = { ...this.state, receivedBytes: remainingBytes };
            continue;
          }
        } else {
          processedFrameContent = frameContentBytes;
        }
        this.state = { ...this.state, receivedBytes: remainingBytes };
        try {
          onFrame(processedFrameContent);
        } catch (error) {
          this.state.logger.error({ err: error }, "Error processing frame");
        }
      } else {
        break;
      }
    }
  }

  private generateIV(counter: number) {
    const iv = new ArrayBuffer(12);
    new DataView(iv).setUint32(8, counter);
    return new Uint8Array(iv);
  }
}
