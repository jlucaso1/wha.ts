import {
  type AuthenticationCreds,
  type IAuthStateProvider,
} from "./state/interface";
import type { ILogger, WebSocketConfig } from "./transport/types";
import { ConnectionManager } from "./core/connection";
import { Authenticator } from "./core/authenticator";
import { DEFAULT_BROWSER, DEFAULT_SOCKET_CONFIG, WA_VERSION } from "./defaults";
import { TypedEventTarget, type TypedCustomEvent } from "./utils/typed-event-target";
import { type ClientEventMap } from "./client-events";
import { type ConnectionUpdatePayload, type CredsUpdatePayload } from "./core/authenticator-events";

export interface ClientConfig {
  auth: IAuthStateProvider;
  logger?: ILogger;
  wsOptions?: Partial<WebSocketConfig>;
  version?: number[];
  browser?: readonly [string, string, string];
}

declare interface WhaTSClient {
  ws: ConnectionManager["ws"];
  auth: IAuthStateProvider;
  logger: ILogger;

  connect(): Promise<void>;
  logout(reason?: string): Promise<void>;

  addListener<K extends keyof ClientEventMap>(
    event: K,
    listener: (data: ClientEventMap[K]) => void
  ): void;
}

class WhaTSClient extends TypedEventTarget<ClientEventMap> {
  private config: Required<Omit<ClientConfig, "logger">> & { logger: ILogger };
  private conn: ConnectionManager;
  private authenticator: Authenticator;

  constructor(config: ClientConfig) {
    super();

    const logger = config.logger || (console as ILogger);

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
            DEFAULT_SOCKET_CONFIG.waWebSocketUrl
        ),
        logger: logger,
      },
    } satisfies ClientConfig;

    this.auth = this.config.auth;
    this.logger = this.config.logger;

    this.conn = new ConnectionManager(
      this.config.wsOptions as WebSocketConfig,
      this.logger,
      this.auth.creds
    );

    this.authenticator = new Authenticator(this.conn, this.auth, this.logger);

    this.authenticator.addEventListener("connection.update", 
      (event: TypedCustomEvent<ConnectionUpdatePayload>) => {
        this.dispatchTypedEvent("connection.update", event.detail);
      });

    this.authenticator.addEventListener("creds.update", 
      (event: TypedCustomEvent<CredsUpdatePayload>) => {
        this.auth
          .saveCreds()
          .then(() => {
            this.dispatchTypedEvent("creds.update", event.detail);
          })
          .catch((err) => {
            this.logger.error({ err }, "Failed to save credentials");
          });
      });

    this.authenticator.addEventListener("_internal.sendNode", 
      (event: TypedCustomEvent<{ node: any }>) => {
        this.conn.sendNode(event.detail.node).catch((err) => {
          this.logger.error(
            { err },
            "Failed to send node requested by Authenticator"
          );
        });
      });

    this.authenticator.addEventListener("_internal.closeConnection",
      (event: TypedCustomEvent<{ error?: Error }>) => {
        const error = event.detail.error;
        this.conn.close(error).catch((err) => {
          this.logger.error(
            { err },
            "Error closing connection on Authenticator request"
          );
        });
      });
  }

  addListener<K extends keyof ClientEventMap>(
    event: K,
    listener: (data: ClientEventMap[K]) => void
  ): void {
    this.addEventListener(event, (
      (e: TypedCustomEvent<ClientEventMap[K]>) => {
        listener(e.detail);
      }) as EventListener);
  }

  async connect(): Promise<void> {
    try {
      await this.conn.connect();
    } catch (error) {
      this.logger.error({ err: error }, "Connection failed");
      throw error;
    }
  }

  async logout(reason: string = "User initiated logout"): Promise<void> {
    await this.conn.close(new Error(reason));
  }
}

export const createWAClient = (config: ClientConfig): WhaTSClient => {
  return new WhaTSClient(config);
};

export { WhaTSClient };
export type { AuthenticationCreds, IAuthStateProvider, ILogger };
