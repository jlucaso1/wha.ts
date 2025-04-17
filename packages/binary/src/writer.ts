export class BinaryWriter {
	private buffer: Uint8Array;
	private length = 0;

	/**
	 * @param initialCapacity Initial capacity of the buffer in bytes
	 */
	constructor(initialCapacity = 1024) {
		this.buffer = new Uint8Array(initialCapacity);
	}

	/**
	 * Ensure the internal buffer can accommodate `additional` bytes,
	 * growing it geometrically if needed.
	 */
	private ensureCapacity(additional: number): void {
		const required = this.length + additional;
		if (required <= this.buffer.length) return;

		let newCapacity = this.buffer.length;
		while (newCapacity < required) {
			newCapacity *= 2;
		}

		const newBuffer = new Uint8Array(newCapacity);
		newBuffer.set(this.buffer.subarray(0, this.length));
		this.buffer = newBuffer;
	}

	/** Write a single byte (0-255) into the buffer. */
	public writeByte(value: number): void {
		this.ensureCapacity(1);
		this.buffer[this.length++] = value & 0xff;
	}

	/** Write an array of bytes into the buffer. */
	public writeBytes(bytes: Uint8Array | number[]): void {
		const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
		this.ensureCapacity(arr.length);
		this.buffer.set(arr, this.length);
		this.length += arr.length;
	}

	/**
	 * Write an n-byte big-endian or little-endian integer.
	 * @param value The integer value to write
	 * @param n Number of bytes
	 * @param littleEndian True for little-endian byte order
	 */
	public writeInt(value: number, n: number, littleEndian = false): void {
		this.ensureCapacity(n);
		for (let i = 0; i < n; i++) {
			const shift = littleEndian ? i : n - 1 - i;
			this.buffer[this.length++] = (value >> (shift * 8)) & 0xff;
		}
	}

	/** Write a 16-bit big-endian integer. */
	public writeInt16(value: number): void {
		this.writeBytes([(value >> 8) & 0xff, value & 0xff]);
	}

	/** Write a 20-bit big-endian integer (only lower 20 bits are used). */
	public writeInt20(value: number): void {
		this.writeBytes([(value >> 16) & 0x0f, (value >> 8) & 0xff, value & 0xff]);
	}

	/** Write a 32-bit big-endian integer. */
	public writeInt32(value: number): void {
		this.writeInt(value, 4);
	}

	/**
	 * Get the written data as a Uint8Array slice containing only the used portion.
	 */
	public getData(): Uint8Array {
		return this.buffer.subarray(0, this.length);
	}
}
