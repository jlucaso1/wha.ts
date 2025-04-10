export class BinaryWriter {
	private buffer: number[] = [];

	writeByte(value: number): void {
		this.buffer.push(value & 0xff);
	}

	writeBytes(bytes: Uint8Array | number[]): void {
		for (const b of bytes) {
			this.buffer.push(b);
		}
	}

	writeInt(value: number, n: number, littleEndian = false): void {
		for (let i = 0; i < n; i++) {
			const shift = littleEndian ? i : n - 1 - i;
			this.buffer.push((value >> (shift * 8)) & 0xff);
		}
	}

	writeInt16(value: number): void {
		this.writeBytes([(value >> 8) & 0xff, value & 0xff]);
	}

	writeInt20(value: number): void {
		this.writeBytes([(value >> 16) & 0x0f, (value >> 8) & 0xff, value & 0xff]);
	}

	writeInt32(value: number): void {
		this.writeInt(value, 4);
	}

	getData(): Uint8Array {
		return Uint8Array.from(this.buffer);
	}
}
