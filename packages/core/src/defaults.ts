const DEFAULT_ORIGIN = "https://web.whatsapp.com";
// An whatsapp version expires after 2 months. When expired, the client will not be able to connect to WhatsApp servers.
export const WA_VERSION = [2, 3000, 1025200398]; // Released on 7/28/2025, 12:25:17 AM, expires on 9/28/2025, 12:25:17 AM

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

export const MIN_PREKEY_COUNT = 10; // Minimum pre-keys to maintain on server
export const PREKEY_UPLOAD_BATCH_SIZE = 30; // Number of pre-keys to upload in a batch

// Disconnect reasons for connection closure
export enum DisconnectReason {
	connectionClosed = 428,
	connectionLost = 408,
	connectionReplaced = 440,
	timedOut = 408,
	loggedOut = 401,
	badSession = 500,
	restartRequired = 515,
	multideviceMismatch = 411,
	forbidden = 403,
	unavailableService = 503,
}
