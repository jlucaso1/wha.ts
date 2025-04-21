const DEFAULT_ORIGIN = "https://web.whatsapp.com";
export const WA_VERSION = [2, 3000, 1022032575];

export const DEFAULT_BROWSER = ["Wha.ts", "Desktop", "0.1"] as const;

export const WHATSAPP_ROOT_CA_PUBLIC_KEY = new Uint8Array([
	0x14, 0x23, 0x75, 0x57, 0x4d, 0xa, 0x58, 0x71, 0x66, 0xaa, 0xe7, 0x1e, 0xbe,
	0x51, 0x64, 0x37, 0xc4, 0xa2, 0x8b, 0x73, 0xe3, 0x69, 0x5c, 0x6c, 0xe1, 0xf7,
	0xf9, 0x54, 0x5d, 0xa8, 0xee, 0x6b,
]);

export const NOISE_MODE = "Noise_XX_25519_AESGCM_SHA256\0\0\0\0";
export const NOISE_WA_HEADER = new Uint8Array([87, 65, 6, 3]);

export const DEFAULT_SOCKET_CONFIG = {
	waWebSocketUrl: "wss://web.whatsapp.com/ws/chat",
	connectTimeoutMs: 20_000,
	defaultQueryTimeoutMs: 60_000,
	origin: DEFAULT_ORIGIN,
};
