import { concatBytes } from "../utils/bytes-utils";
import type { NoiseProcessor } from "./noise-processor";
import type { ILogger } from "./types";

export class FrameHandler {
	private receivedBuffer: Uint8Array = new Uint8Array(0);
	private hasSentPrologue = false;

	constructor(
		private readonly noiseProcessor: NoiseProcessor,
		private readonly logger: ILogger,
		private readonly onFrame: (
			decryptedPayload: Uint8Array,
		) => void | Promise<void>,
		private readonly routingInfo?: Uint8Array,
		private readonly noisePrologue: Uint8Array = new Uint8Array(0),
	) {}

	async handleReceivedData(newData: Uint8Array): Promise<void> {
		this.receivedBuffer = concatBytes(this.receivedBuffer, newData);

		while (this.receivedBuffer.length >= 3) {
			const view = new DataView(
				this.receivedBuffer.buffer,
				this.receivedBuffer.byteOffset,
				this.receivedBuffer.byteLength,
			);
			const frameLength = (view.getUint8(0) << 16) | view.getUint16(1, false);

			if (this.receivedBuffer.length < 3 + frameLength) {
				break;
			}

			const encryptedFrame = this.receivedBuffer.subarray(3, 3 + frameLength);
			const remaining = this.receivedBuffer.subarray(3 + frameLength);

			let decryptedPayload: Uint8Array;
			try {
				if (this.noiseProcessor.isHandshakeFinished) {
					decryptedPayload =
						await this.noiseProcessor.decryptMessage(encryptedFrame);
				} else {
					decryptedPayload = encryptedFrame;
				}
			} catch (err) {
				this.logger.error({}, "Frame decryption failed");
				this.receivedBuffer = remaining;
				continue;
			}

			try {
				await this.onFrame(decryptedPayload);
			} catch (err) {
				this.logger.error({ err }, "Error in frame callback");
			}

			this.receivedBuffer = remaining;
		}
	}

	async framePayload(payload: Uint8Array): Promise<Uint8Array> {
		let encryptedPayload: Uint8Array;
		if (this.noiseProcessor.isHandshakeFinished) {
			encryptedPayload = await this.noiseProcessor.encryptMessage(payload);
		} else {
			encryptedPayload = payload;
		}

		let headerBytes: Uint8Array = new Uint8Array(0);
		if (!this.hasSentPrologue) {
			if (this.routingInfo) {
				const PREFIX_LENGTH = 7;
				const PREFIX_IDENTIFIER = "ED";
				const PREFIX_VERSION_MAJOR = 0;
				const PREFIX_VERSION_MINOR = 1;

				const prefix = new Uint8Array(PREFIX_LENGTH);
				const view = new DataView(prefix.buffer);
				prefix.set(
					[...PREFIX_IDENTIFIER].map((c) => c.charCodeAt(0)),
					0,
				);
				view.setUint8(2, PREFIX_VERSION_MAJOR);
				view.setUint8(3, PREFIX_VERSION_MINOR);
				view.setUint8(4, this.routingInfo.length >> 16);
				view.setUint16(5, this.routingInfo.length & 0xffff, false);
				headerBytes = concatBytes(prefix, this.routingInfo, this.noisePrologue);
			} else {
				headerBytes = this.noisePrologue;
			}
			this.hasSentPrologue = true;
		}

		const frameLength = encryptedPayload.length;
		const lengthPrefix = new Uint8Array(3);
		const view = new DataView(lengthPrefix.buffer);
		view.setUint8(0, frameLength >> 16);
		view.setUint16(1, frameLength & 0xffff, false);

		return concatBytes(headerBytes, lengthPrefix, encryptedPayload);
	}

	resetFramingState() {
		this.receivedBuffer = new Uint8Array(0);
		this.hasSentPrologue = false;
	}
}
