import { concatBytes, Mutex } from "@wha.ts/utils";
import type { NoiseProcessor } from "./noise-processor";
import type { ILogger } from "./types";

export class FrameHandler extends EventTarget {
	private chunks: Uint8Array[] = [];
	private bufferedBytes = 0;

	private hasSentPrologue = false;
	private handleDataMutex = new Mutex();

	constructor(
		private readonly noiseProcessor: NoiseProcessor,
		private readonly logger: ILogger,
		private readonly onFrame: (
			decryptedPayload: Uint8Array,
		) => void | Promise<void>,
		private readonly routingInfo?: Uint8Array,
		private readonly noisePrologue: Uint8Array = new Uint8Array(0),
	) {
		super();
	}

	private peekBytes(count: number): Uint8Array | null {
		if (this.bufferedBytes < count) {
			return null;
		}
		const result = new Uint8Array(count);
		let bytesCopied = 0;
		let chunkIndex = 0;
		while (bytesCopied < count && chunkIndex < this.chunks.length) {
			const chunk = this.chunks[chunkIndex];
			if (!chunk) {
				this.logger.error(
					{ chunkIndex, chunksLength: this.chunks.length },
					"Internal error: chunk is undefined in peekBytes.",
				);
				return null;
			}
			const bytesToCopy = Math.min(count - bytesCopied, chunk.length);
			result.set(chunk.subarray(0, bytesToCopy), bytesCopied);
			bytesCopied += bytesToCopy;
			chunkIndex++;
		}
		if (bytesCopied !== count) {
			this.logger.error(
				{
					bufferedBytes: this.bufferedBytes,
					requested: count,
					copied: bytesCopied,
				},
				"Internal error: Mismatch peeking bytes, buffer state likely corrupt.",
			);
			return null;
		}
		return result;
	}

	private consumeBytes(count: number): Uint8Array | null {
		if (this.bufferedBytes < count) {
			this.logger.error(
				{ bufferedBytes: this.bufferedBytes, requested: count },
				"Internal error: Attempted to consume more bytes than available.",
			);
			return null;
		}

		const result = new Uint8Array(count);
		let bytesCopied = 0;
		let bytesConsumedFromTotal = 0;

		while (bytesCopied < count && this.chunks.length > 0) {
			const chunk = this.chunks[0];
			if (!chunk) {
				this.logger.error(
					{ chunksLength: this.chunks.length },
					"Internal error: chunk is undefined in consumeBytes.",
				);
				return null;
			}
			const bytesToCopy = Math.min(count - bytesCopied, chunk.length);

			result.set(chunk.subarray(0, bytesToCopy), bytesCopied);
			bytesCopied += bytesToCopy;
			bytesConsumedFromTotal += bytesToCopy;

			if (bytesToCopy === chunk.length) {
				this.chunks.shift();
			} else {
				this.chunks[0] = chunk.subarray(bytesToCopy);
			}
		}
		this.bufferedBytes -= bytesConsumedFromTotal;

		if (bytesCopied !== count) {
			this.logger.error(
				{
					requested: count,
					copied: bytesCopied,
					finalBuffered: this.bufferedBytes,
				},
				"Internal error: Mismatch consuming bytes, buffer state likely corrupt.",
			);
			return null;
		}

		return result;
	}

	async handleReceivedData(newData: Uint8Array): Promise<void> {
		if (!newData || newData.length === 0) {
			return;
		}

		await this.handleDataMutex.runExclusive(async () => {
			this.chunks.push(newData);
			this.bufferedBytes += newData.length;

			while (true) {
				if (this.bufferedBytes < 3) {
					break;
				}

				const lengthPrefixBytes = this.peekBytes(3);
				if (!lengthPrefixBytes) {
					break;
				}

				const view = new DataView(
					lengthPrefixBytes.buffer,
					lengthPrefixBytes.byteOffset,
					lengthPrefixBytes.byteLength,
				);
				const frameLength = (view.getUint8(0) << 16) | view.getUint16(1, false);
				const totalFrameLength = 3 + frameLength;

				if (this.bufferedBytes < totalFrameLength) {
					break;
				}

				const frameData = this.consumeBytes(totalFrameLength);
				if (!frameData) {
					this.logger.error(
						{},
						"Critical error consuming frame data, stopping processing.",
					);
					break;
				}

				const encryptedFrame = frameData.subarray(3);

				let decryptedPayload: Uint8Array;
				try {
					if (this.noiseProcessor.isHandshakeFinished) {
						decryptedPayload =
							this.noiseProcessor.decryptMessage(encryptedFrame);
					} else {
						decryptedPayload = encryptedFrame;
					}
				} catch (err) {
					this.logger.error({ err }, "Frame decryption failed");
					continue;
				}

				try {
					await this.onFrame(decryptedPayload);
				} catch (err) {
					this.logger.error({ err }, "Error in frame callback");
				}
			}
		});
	}

	async framePayload(payload: Uint8Array): Promise<Uint8Array> {
		let encryptedPayload: Uint8Array;
		if (this.noiseProcessor.isHandshakeFinished) {
			encryptedPayload = this.noiseProcessor.encryptMessage(payload);
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
				view.setUint8(4, (this.routingInfo.length >> 16) & 0xff);
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
		view.setUint8(0, (frameLength >> 16) & 0xff);
		view.setUint16(1, frameLength & 0xffff, false);

		const framed = concatBytes(headerBytes, lengthPrefix, encryptedPayload);

		return framed;
	}

	resetFramingState() {
		this.chunks = [];
		this.bufferedBytes = 0;
		this.hasSentPrologue = false;
	}
}
