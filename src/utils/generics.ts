export const encodeBigEndian = (num: number, bytes: number = 4): Uint8Array => {
  if (bytes <= 0) {
    throw new Error("Number of bytes must be positive");
  }
  const arr = new Uint8Array(bytes);
  const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);

  switch (bytes) {
    case 1:
      view.setUint8(0, num);
      break;
    case 2:
      view.setUint16(0, num, false);
      break;
    case 3:
      if (num >= 1 << 24) throw new Error("Number too large for 3 bytes");
      view.setUint8(0, (num >> 16) & 0xff);
      view.setUint16(1, num & 0xffff, false);
      break;
    case 4:
      view.setUint32(0, num, false);
      break;
    default:
      let remnant = num;
      for (let i = bytes - 1; i >= 0; i--) {
        arr[i] = remnant & 0xff;
        remnant >>>= 8;
      }
      if (remnant !== 0 && remnant !== -1) {
        console.warn(
          `Number ${num} might be too large for ${bytes} bytes in encodeBigEndian`,
        );
      }
  }

  return arr;
};

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const unixTimestampSeconds = (date: Date = new Date()): number =>
  Math.floor(date.getTime() / 1000);
