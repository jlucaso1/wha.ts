import { EventEmitter } from "node:events";
import { URL } from "node:url";

import {
  type AuthenticationCreds,
  type IAuthStateProvider,
} from "./state/interface";
import { MemoryAuthState } from "./state/providers/memory";
import type { ILogger, WebSocketConfig } from "./transport/types";
import { ConnectionManager } from "./core/connection";
import { Authenticator, type AuthenticatorEvents } from "./core/authenticator";
import { DEFAULT_BROWSER, DEFAULT_SOCKET_CONFIG, WA_VERSION } from "./defaults";
import type { BinaryNode } from "./binary";

export interface ClientConfig {
  auth: IAuthStateProvider;
  logger?: ILogger;
  wsOptions?: Partial<WebSocketConfig>;
  version?: number[];
  browser?: readonly [string, string, string];
}

export interface ClientEvents extends AuthenticatorEvents {
  "connection.update": AuthenticatorEvents["connection.update"];
  "creds.update": AuthenticatorEvents["creds.update"];
}

declare interface WhaTSClient {
  on<U extends keyof ClientEvents>(event: U, listener: ClientEvents[U]): this;
  emit<U extends keyof ClientEvents>(
    event: U,
    ...args: Parameters<ClientEvents[U]>
  ): boolean;
  ws: ConnectionManager["ws"];
  auth: IAuthStateProvider;
  logger: ILogger;
}

class WhaTSClient extends EventEmitter {
  private config: Required<Omit<ClientConfig, "logger">> & { logger: ILogger };
  private conn: ConnectionManager;
  private authenticator: Authenticator;

  constructor(config: ClientConfig) {
    super();
    this.setMaxListeners(0);

    const logger = config.logger || console as ILogger;

    this.config = {
      auth: config.auth,
      logger: logger,
      version: config.version || WA_VERSION,
      browser: config.browser || DEFAULT_BROWSER,
      wsOptions: {
        ...DEFAULT_SOCKET_CONFIG,
        ...(config.wsOptions || {}),
        url: new URL(
          config.wsOptions?.url?.toString() ||
            DEFAULT_SOCKET_CONFIG.waWebSocketUrl,
        ),
        logger: logger,
      },
    } satisfies ClientConfig;

    this.auth = this.config.auth;
    this.logger = this.config.logger;

    this.conn = new ConnectionManager(
      this.config.wsOptions as WebSocketConfig,
      this.logger,
      this.auth.creds,
    );

    this.authenticator = new Authenticator(
      this.conn,
      this.auth,
      this.logger,
    );

    this.authenticator.on("connection.update", (update) => {
      this.emit("connection.update", update);
      if (update.connection === "close" && update.error) {
        throw update.error;
      }
    });

    this.authenticator.on("creds.update", (update) => {
      this.logger.info("Saving updated credentials...");
      this.auth
        .saveCreds()
        .then(() => {
          this.logger.info("Credentials saved successfully");
          this.emit("creds.update", update);
        })
        .catch((err) => {
          this.logger.error({ err }, "Failed to save credentials");
        });
    });

    this.authenticator.on("_internal.sendNode", (node: BinaryNode) => {
      this.logger.debug({ tag: node.tag }, "Authenticator requested sendNode");
      this.conn.sendNode(node).catch((err) => {
        this.logger.error({ err }, "Failed to send node requested by Authenticator");
      });
    });

    this.authenticator.on("_internal.closeConnection", (error?: Error) => {
      this.logger.debug({ err: error }, "Authenticator requested connection close");
      this.conn.close(error).catch((err) => {
        this.logger.error({ err }, "Error closing connection on Authenticator request");
      });
    });

    this.logger.info("Wha.ts Client Initialized");
  }

  async connect(): Promise<void> {
    this.logger.info("Initiating connection...");
    try {
      await this.conn.connect();
      this.logger.info("WebSocket connection initiated, handshake pending...");
    } catch (error) {
      this.logger.error({ err: error }, "Connection failed");
      throw error;
    }
  }

  async logout(reason: string = "User initiated logout"): Promise<void> {
    this.logger.info({ reason }, "Initiating logout...");
    await this.conn.close(new Error(reason));
    this.logger.info("Logout complete");
  }
}

export const createWAClient = (config: ClientConfig): WhaTSClient => {
  return new WhaTSClient(config);
};

export { MemoryAuthState, WhaTSClient };
export type { AuthenticationCreds, IAuthStateProvider, ILogger };
