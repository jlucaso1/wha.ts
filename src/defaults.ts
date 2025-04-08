export const DEFAULT_ORIGIN = "https://web.whatsapp.com";
export const WA_VERSION = [2, 3000, 1020608496];
export const WA_DEFAULT_EPHEMERAL = 0;
export const KEY_BUNDLE_TYPE = new Uint8Array([5]);

export const DEFAULT_BROWSER = ["Ubuntu", "Desktop", "0.1"] as const;

export const NOISE_MODE = "Noise_XX_25519_AESGCM_SHA256\0\0\0\0";
export const NOISE_WA_HEADER = new Uint8Array([87, 65, 6, 2]);

export const DEFAULT_SOCKET_CONFIG = {
  waWebSocketUrl: "wss://web.whatsapp.com/ws/chat",
  connectTimeoutMs: 20_000,
  keepAliveIntervalMs: 25_000,
  defaultQueryTimeoutMs: 60_000,
  origin: DEFAULT_ORIGIN,
};

export const WA_CERT_DETAILS = { SERIAL: 0 };
