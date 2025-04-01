import { EventEmitter } from "node:events";
import { URL } from "node:url";

import {
  type AuthenticationCreds,
  type IAuthStateProvider,
} from "./state/interface";
import { MemoryAuthState } from "./state/providers/memory";
import type { WebSocketConfig, ILogger } from "./transport/types";
import { ConnectionManager } from "./core/connection";
import { Authenticator, type AuthenticatorEvents } from "./core/authenticator";
import { DEFAULT_BROWSER, DEFAULT_SOCKET_CONFIG, WA_VERSION } from "./defaults";

// --- Client Configuration ---

export interface ClientConfig {
  /** Provide an object to manage authentication state */
  auth: IAuthStateProvider;
  /** Logger instance */
  logger?: ILogger;
  /** WebSocket connection options */
  wsOptions?: Partial<WebSocketConfig>;
  /** Version of WA to emulate */
  version?: number[];
  /** Browser description to emulate */
  browser?: readonly [string, string, string];
  // Add other config options as needed (e.g., proxy, fetch implementation)
}

// --- Client Events ---

// Define the events the main client will emit
// Re-emitting events from internal components for user consumption
export interface ClientEvents extends AuthenticatorEvents {
  "connection.update": AuthenticatorEvents["connection.update"];
  "creds.update": AuthenticatorEvents["creds.update"];
  // Add other events later (e.g., 'messages.upsert', 'contacts.update')
}

// --- Main Client Class (using EventEmitter pattern) ---

declare interface WhaTSClient {
  on<U extends keyof ClientEvents>(event: U, listener: ClientEvents[U]): this;
  emit<U extends keyof ClientEvents>(
    event: U,
    ...args: Parameters<ClientEvents[U]>
  ): boolean;
  ws: ConnectionManager["ws"]; // Expose underlying WS for potential advanced use?
  auth: IAuthStateProvider;
  logger: ILogger;
}

class WhaTSClient extends EventEmitter {
  private config: Required<Omit<ClientConfig, "logger">> & { logger: ILogger }; // Fully populated config
  private conn: ConnectionManager;
  private authenticator: Authenticator;

  constructor(config: ClientConfig) {
    super();
    this.setMaxListeners(0); // Allow multiple listeners

    // --- Initialize Config and Logger ---
    const logger = config.logger || console as ILogger; // Fallback to console

    // Ensure default values are set
    this.config = {
      auth: config.auth,
      logger: logger,
      version: config.version || WA_VERSION,
      browser: config.browser || DEFAULT_BROWSER,
      wsOptions: {
        ...DEFAULT_SOCKET_CONFIG, // Start with defaults
        ...(config.wsOptions || {}), // Apply user overrides
        url: new URL(
          config.wsOptions?.url?.toString() ||
            DEFAULT_SOCKET_CONFIG.waWebSocketUrl
        ), // Ensure URL object
        logger: logger, // Pass logger to WS config
      },
    };

    this.auth = this.config.auth;
    this.logger = this.config.logger;

    // --- Instantiate Core Components ---
    this.conn = new ConnectionManager(
      this.config.wsOptions as WebSocketConfig, // Cast as it's now fully populated
      this.auth.creds.noiseKey, // CRITICAL: Pass the static noise key
      this.logger,
      this.auth.creds.routingInfo // Pass routing info if available
    );

    this.authenticator = new Authenticator(
      this.conn,
      this.auth,
      this.logger
      // Pass version/browser info if Authenticator needs it directly
      // this.config.version,
      // this.config.browser
    );

    // --- Wire Up Internal Events ---

    // Forward Authenticator events to the main client emitter
    this.authenticator.on("connection.update", (update) => {
      this.emit("connection.update", update);
      // Update routing info if connection closes unexpectedly
      if (update.connection === "close" && update.error) {
        // Potentially clear routing info here if the error suggests it's invalid
        // if (shouldClearRoutingInfo(update.error)) {
        //     this.logger.warn("Clearing routing info due to connection error");
        //     this.auth.creds.routingInfo = undefined;
        //     this.auth.saveCreds(); // Save the cleared info
        // }
      }
    });

    this.authenticator.on("creds.update", (update) => {
      // Save credentials whenever the authenticator requests it
      this.logger.info("Saving updated credentials...");
      this.auth
        .saveCreds()
        .then(() => {
          this.logger.info("Credentials saved successfully");
          this.emit("creds.update", update); // Emit *after* saving
        })
        .catch((err) => {
          this.logger.error({ err }, "Failed to save credentials");
          // Optionally emit an error event
        });
    });

    // TODO: Listen for ConnectionManager events if needed directly by the client
    // this.conn.on('state.change', (state, error) => { ... });
    // this.conn.on('error', (error) => { ... });

    this.logger.info("Wha.ts Client Initialized");
  }

  // --- Public API Methods ---

  /** Connects to WhatsApp Web and starts the authentication process */
  async connect(): Promise<void> {
    this.logger.info("Initiating connection...");
    try {
      await this.conn.connect();
      // The rest of the flow (handshake, auth) is handled by the internal event listeners
      this.logger.info("WebSocket connection initiated, handshake pending...");
    } catch (error) {
      this.logger.error({ err: error }, "Connection failed");
      // Ensure connection state is updated via events if connect fails
      throw error; // Re-throw for the caller
    }
  }

  /** Disconnects the client */
  async logout(reason: string = "User initiated logout"): Promise<void> {
    this.logger.info({ reason }, "Initiating logout...");
    // TODO: Send logout notification if needed? Check Baileys logout logic.
    // e.g., await this.sendNode(...)
    await this.conn.close(new Error(reason));
    // TODO: Clear specific creds on logout? (e.g., me, account)
    // this.auth.creds.me = undefined;
    // await this.auth.saveCreds();
    this.logger.info("Logout complete");
  }
}

/**
 * Creates a new Wha.ts client instance.
 *
 * @param config Client configuration options. Requires at least `auth` state provider.
 * @returns A new WhaTSClient instance.
 */
export const createWAClient = (config: ClientConfig): WhaTSClient => {
  return new WhaTSClient(config);
};

// Example Usage (replace with actual usage later)
/*
async function runExample() {
    const authState = new MemoryAuthState(); // Or load from file
    const client = createWAClient({ auth: authState });

    client.on('connection.update', (update) => {
        console.log('Connection Update:', update);
        if (update.qr) {
            console.log('QR Code Received:', update.qr);
            // Render QR code here (e.g., using qrcode-terminal)
        }
        if (update.connection === 'open') {
            console.log('Connection Open!');
        }
        if (update.connection === 'close') {
            console.log('Connection Closed:', update.error?.message);
        }
    });

    client.on('creds.update', (update) => {
        console.log('Credentials Updated:', update);
    });

    try {
        await client.connect();
        console.log('Connect function returned, waiting for events...');
    } catch (error) {
        console.error('Failed to connect:', error);
    }
}

// runExample();
*/

// Export core types/classes for external use
export { WhaTSClient, MemoryAuthState };
export type { IAuthStateProvider, AuthenticationCreds, ILogger };
