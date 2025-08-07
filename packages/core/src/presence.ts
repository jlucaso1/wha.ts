import type { BinaryNode, SINGLE_BYTE_TOKENS_TYPE } from "@wha.ts/binary";
import type { IAuthStateProvider } from "@wha.ts/types";
import type { ConnectionManager } from "./core/connection";
import type { ILogger } from "./transport/types";

type EnsureSubtype<Source, T extends Source> = T;

export type PresenceState = EnsureSubtype<
	SINGLE_BYTE_TOKENS_TYPE,
	"available" | "unavailable"
>;

export type ChatState = EnsureSubtype<
	SINGLE_BYTE_TOKENS_TYPE,
	"composing" | "paused"
>;

export class PresenceManager {
	constructor(
		private connectionManager: ConnectionManager,
		private auth: IAuthStateProvider,
		private logger: ILogger,
	) {
		this.connectionManager.addEventListener("state.change", (event) => {
			if (event.detail.state === "open") {
				this.sendUpdate("available").catch((err) => {
					this.logger.error(
						{ err },
						"Failed to send 'available' presence update on connection open",
					);
				});
			}
		});
	}

	public async sendUpdate(
		type: PresenceState | ChatState,
		toJid?: string,
	): Promise<void> {
		const me = this.auth.creds.me;
		if (!me) {
			throw new Error(
				"Cannot send presence update without being authenticated",
			);
		}

		let node: BinaryNode;
		if (type === "available" || type === "unavailable") {
			if (!me.name) {
				this.logger.warn("No client name set, skipping presence update");
				return;
			}
			node = {
				tag: "presence",
				attrs: {
					name: me.name,
					type,
				},
			};
		} else {
			if (!toJid) {
				throw new Error("`toJid` is required for composing/paused presence");
			}
			node = {
				tag: "chatstate",
				attrs: {
					from: me.id,
					to: toJid,
				},
				content: [{ tag: type, attrs: {} }],
			};
		}

		this.logger.debug({ to: toJid, type }, "sending presence update");
		await this.connectionManager.sendNode(node);
	}
}
