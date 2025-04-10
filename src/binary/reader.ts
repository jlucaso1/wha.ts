import { bytesToUtf8 } from '../utils/bytes-utils';

export class BinaryReader {
  private buffer: Uint8Array;
  private index = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  readByte(): number {
    this.checkEOS(1);
    return this.buffer[this.index++]!;
  }

  readBytes(n: number): Uint8Array {
    this.checkEOS(n);
    const val = this.buffer.slice(this.index, this.index + n);
    this.index += n;
    return val;
  }

  readInt(n: number, littleEndian = false): number {
    this.checkEOS(n);
    let val = 0;
    for (let i = 0; i < n; i++) {
      const shift = littleEndian ? i : n - 1 - i;
      val |= this.readByte() << (shift * 8);
    }
    return val;
  }

  readInt16(): number {
    return this.readInt(2);
  }

  readInt20(): number {
    this.checkEOS(3);
    return ((this.readByte() & 0x0f) << 16) | (this.readByte() << 8) | this.readByte();
  }

  readInt32(): number {
    return this.readInt(4);
  }

  readString(length: number): string {
    return bytesToUtf8(this.readBytes(length));
  }

  isEOS(): boolean {
    return this.index >= this.buffer.length;
  }

  checkEOS(length: number): void {
    if (this.index + length > this.buffer.length) {
      throw new Error('end of stream');
    }
  }

  currentOffset(): number {
    return this.index;
  }
}
