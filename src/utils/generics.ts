// src/utils/generics.ts
import { Buffer } from "node:buffer";

/**
 * Encodes a number into a Big Endian Uint8Array/Buffer.
 * @param num The number to encode.
 * @param bytes The number of bytes for the output array (e.g., 3 for Int20, 4 for Int32).
 * @returns A Buffer containing the Big Endian representation.
 */
export const encodeBigEndian = (num: number, bytes: number = 4): Buffer => {
  if (bytes <= 0) {
    throw new Error("Number of bytes must be positive");
  }
  // Using Node.js Buffer's built-in methods for efficiency and correctness
  const buffer = Buffer.alloc(bytes);

  // Dynamically choose the correct write method based on byte count
  // Note: Node's write methods handle potential range errors.
  switch (bytes) {
    case 1:
      buffer.writeUInt8(num, 0);
      break;
    case 2:
      buffer.writeUInt16BE(num, 0); // BE for Big Endian
      break;
    case 3:
      // Special case for 20-bit (3 bytes) - write high byte then low 2 bytes
      if (num >= 1 << 24) throw new Error("Number too large for 3 bytes");
      buffer.writeUInt8((num >> 16) & 0xff, 0); // Highest 8 bits (of the 24 bits used)
      buffer.writeUInt16BE(num & 0xffff, 1); // Lowest 16 bits
      break;
    case 4:
      buffer.writeUInt32BE(num, 0); // BE for Big Endian
      break;
    // Add cases for larger integers (like 64-bit using BigInt) if needed
    // case 8:
    //     buffer.writeBigUInt64BE(BigInt(num), 0); // Requires num to be BigInt or cast
    //     break;
    default:
      // Manual implementation for arbitrary byte lengths (less efficient)
      let remnant = num;
      for (let i = bytes - 1; i >= 0; i--) {
        const byteVal = remnant & 0xff;
        buffer[i] = byteVal;
        // Use unsigned right shift for positive numbers, consider Math.floor(remnant / 256) for negatives
        remnant >>>= 8;
      }
      if (remnant !== 0 && remnant !== -1) {
        // Check if number fully fit
        console.warn(
          `Number ${num} might be too large for ${bytes} bytes in encodeBigEndian`
        );
      }
  }

  return buffer;
};

// You can add other generic utilities here later, for example:

/** Creates a delay Promise */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Returns the Unix timestamp in seconds */
export const unixTimestampSeconds = (date: Date = new Date()): number =>
  Math.floor(date.getTime() / 1000);

// Add promiseTimeout, bytesToCrockford, etc., from Baileys' generics if/when needed.
