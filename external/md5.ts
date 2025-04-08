export function md5External(data: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0xd76aa478,
    0xe8c7b756,
    0x242070db,
    0xc1bdceee,
    0xf57c0faf,
    0x4787c62a,
    0xa8304613,
    0xfd469501,
    0x698098d8,
    0x8b44f7af,
    0xffff5bb1,
    0x895cd7be,
    0x6b901122,
    0xfd987193,
    0xa679438e,
    0x49b40821,
    0xf61e2562,
    0xc040b340,
    0x265e5a51,
    0xe9b6c7aa,
    0xd62f105d,
    0x02441453,
    0xd8a1e681,
    0xe7d3fbc8,
    0x21e1cde6,
    0xc33707d6,
    0xf4d50d87,
    0x455a14ed,
    0xa9e3e905,
    0xfcefa3f8,
    0x676f02d9,
    0x8d2a4c8a,
    0xfffa3942,
    0x8771f681,
    0x6d9d6122,
    0xfde5380c,
    0xa4beea44,
    0x4bdecfa9,
    0xf6bb4b60,
    0xbebfbc70,
    0x289b7ec6,
    0xeaa127fa,
    0xd4ef3085,
    0x04881d05,
    0xd9d4d039,
    0xe6db99e5,
    0x1fa27cf8,
    0xc4ac5665,
    0xf4292244,
    0x432aff97,
    0xab9423a7,
    0xfc93a039,
    0x655b59c3,
    0x8f0ccc92,
    0xffeff47d,
    0x85845dd1,
    0x6fa87e4f,
    0xfe2ce6e0,
    0xa3014314,
    0x4e0811a1,
    0xf7537e82,
    0xbd3af235,
    0x2ad7d2bb,
    0xeb86d391,
  ]);

  const S = new Uint8Array([
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
  ]);

  const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
  const G = (x: number, y: number, z: number) => (x & z) | (y & ~z);
  const H = (x: number, y: number, z: number) => x ^ y ^ z;
  const I = (x: number, y: number, z: number) => y ^ (x | ~z);

  const ROTATE_LEFT = (x: number, n: number) => (x << n) | (x >>> (32 - n));

  const add32 = (a: number, b: number) => {
    return (a + b) & 0xFFFFFFFF;
  };

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const paddedLength = (((data.length + 8) >>> 6) + 1) << 6;
  const paddedData = new Uint8Array(paddedLength);
  paddedData.set(data, 0);
  paddedData[data.length] = 0x80;

  const bitLength = data.length * 8;
  const dataView = new DataView(paddedData.buffer);
  dataView.setUint32(paddedLength - 8, bitLength, true);
  dataView.setUint32(paddedLength - 4, 0, true);

  for (let i = 0; i < paddedLength; i += 64) {
    const words = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      words[j] = dataView.getUint32(i + j * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let j = 0; j < 64; j++) {
      let f: number, g: number;

      if (j < 16) {
        f = F(b, c, d);
        g = j;
      } else if (j < 32) {
        f = G(b, c, d);
        g = (5 * j + 1) % 16;
      } else if (j < 48) {
        f = H(b, c, d);
        g = (3 * j + 5) % 16;
      } else {
        f = I(b, c, d);
        g = (7 * j) % 16;
      }

      const temp = d;
      d = c;
      c = b;
      b = add32(
        b,
        ROTATE_LEFT(add32(add32(a, f), add32(K[j]!, words[g]!)), S[j]!),
      );
      a = temp;
    }

    a0 = add32(a0, a);
    b0 = add32(b0, b);
    c0 = add32(c0, c);
    d0 = add32(d0, d);
  }

  const hashBytes = new Uint8Array(16);
  const hashView = new DataView(hashBytes.buffer);
  hashView.setUint32(0, a0, true);
  hashView.setUint32(4, b0, true);
  hashView.setUint32(8, c0, true);
  hashView.setUint32(12, d0, true);

  return hashBytes;
}
