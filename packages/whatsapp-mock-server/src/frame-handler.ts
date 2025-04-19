import { encodeBinaryNode } from "@wha.ts/binary/src/encode";
import type { BinaryNode } from "@wha.ts/binary/src/types";
import { bytesToHex, concatBytes } from "@wha.ts/utils/src/bytes-utils";

const logger = console;

export function addLengthPrefix(data: Uint8Array): Uint8Array {
	const frameLength = data.length;
	const lengthPrefix = new Uint8Array(3);
	const view = new DataView(lengthPrefix.buffer);
	view.setUint8(0, (frameLength >> 16) & 0xff);
	view.setUint16(1, frameLength & 0xffff, false); // Big Endian
	return concatBytes(lengthPrefix, data);
}

export function frameBinaryNode(node: BinaryNode): Uint8Array {
	const encoded = encodeBinaryNode(node);
	return addLengthPrefix(encoded);
}

// Basic frame parsing logic (can be part of the message handler)
export function parseFrames(
	buffer: Uint8Array,
	onFrame: (frame: Uint8Array) => void,
): Uint8Array {
	let currentBuffer = buffer;
	// +++ Add detailed logs +++
	logger.debug(
		`[parseFrames] Start processing buffer. Initial Length: ${
			currentBuffer.length
		}, Hex: ${bytesToHex(
			currentBuffer.slice(0, Math.min(currentBuffer.length, 10)),
		)}...`,
	);

	while (currentBuffer.length >= 3) {
		logger.debug(
			`[parseFrames] Loop iteration. Buffer length: ${currentBuffer.length}`,
		);
		const view = new DataView(
			currentBuffer.buffer,
			currentBuffer.byteOffset,
			3,
		);
		const frameLength = (view.getUint8(0) << 16) | view.getUint16(1, false);
		const totalFrameLength = 3 + frameLength;
		logger.debug(
			`[parseFrames] Read length prefix: ${frameLength}. Total frame length needed: ${totalFrameLength}.`,
		);

		if (currentBuffer.length >= totalFrameLength) {
			logger.debug(
				`[parseFrames] Buffer has enough data (${currentBuffer.length} >= ${totalFrameLength}). Extracting frame.`,
			);
			const frameData = currentBuffer.slice(3, totalFrameLength);
			logger.debug(
				`[parseFrames] Extracted frameData. Length: ${
					frameData.length
				}. Hex: ${bytesToHex(
					frameData.slice(0, Math.min(frameData.length, 10)),
				)}...`,
			);
			try {
				logger.debug("[parseFrames] Calling onFrame callback...");
				onFrame(frameData); // Call the provided callback (handleCompleteFrame)
				logger.debug("[parseFrames] onFrame callback finished.");
			} catch (e) {
				logger.error(
					"[parseFrames] Error occurred *during* onFrame execution:",
					e,
				);
				// Depending on error handling strategy, you might want to break or continue
				break; // Stop processing if the callback fails
			}
			currentBuffer = currentBuffer.slice(totalFrameLength);
			logger.debug(
				`[parseFrames] Consumed frame from buffer. Remaining length: ${currentBuffer.length}`,
			);
		} else {
			logger.debug(
				`[parseFrames] Buffer does not have enough data (${currentBuffer.length} < ${totalFrameLength}). Breaking loop.`,
			);
			break; // Not enough data for a full frame
		}
	}
	logger.debug(
		`[parseFrames] Finished processing buffer loop. Returning remaining buffer. Length: ${currentBuffer.length}`,
	);
	return currentBuffer;
}
