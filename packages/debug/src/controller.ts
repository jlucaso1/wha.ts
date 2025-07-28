import { DebugDataStore, type DebugDataStoreOptions } from "./datastore";
import { attachHooks, detachHooks, type WhaTsCoreModules } from "./hooks";
import type {
	ClientEventRecord,
	ComponentStateSnapshot,
	ErrorRecord,
	NetworkEvent,
} from "./types";

export const deepClone = <T>(obj: T): T => {
	if (obj === null || typeof obj !== "object") {
		return obj;
	}
	if (obj instanceof Uint8Array) {
		// Return a copy to prevent mutation of the original object
		return new Uint8Array(obj) as T;
	}
	if (obj instanceof Date) {
		return new Date(obj.getTime()) as T;
	}
	if (Array.isArray(obj)) {
		return obj.map((item) => deepClone(item)) as T;
	}
	const cloned: { [key: string]: any } = {};
	for (const key in obj) {
		if (Object.hasOwn(obj, key)) {
			cloned[key] = deepClone((obj as Record<string, unknown>)[key]);
		}
	}
	return cloned as T;
};

export class DebugController {
	public dataStore: DebugDataStore;
	private coreModules?: WhaTsCoreModules;
	private isHooksAttached = false;

	constructor(options?: DebugDataStoreOptions) {
		this.dataStore = new DebugDataStore(options);
	}

	public attachHooks(coreModules: WhaTsCoreModules): void {
		if (this.isHooksAttached) {
			console.warn("[DebugController] Hooks already attached.");
			return;
		}
		this.coreModules = coreModules;
		attachHooks(this, coreModules);
		this.isHooksAttached = true;
		console.log("[DebugController] Hooks attached to core modules.");
	}

	public detachHooks(): void {
		if (!this.isHooksAttached || !this.coreModules) {
			console.warn(
				"[DebugController] Hooks not attached or core modules not set.",
			);
			return;
		}
		detachHooks(this.coreModules);
		this.isHooksAttached = false;
		this.coreModules = undefined;
		console.log("[DebugController] Hooks detached.");
	}

	public get waClient() {
		return this.coreModules?.client;
	}

	public recordNetworkEvent(eventData: Omit<NetworkEvent, "timestamp">): void {
		let event: NetworkEvent;
		if (
			eventData.layer === "websocket_raw" ||
			eventData.layer === "frame_raw" ||
			eventData.layer === "noise_payload"
		) {
			event = {
				...(eventData as Omit<
					Extract<
						NetworkEvent,
						{ layer: "websocket_raw" | "frame_raw" | "noise_payload" }
					>,
					"timestamp"
				>),
				data:
					eventData.data instanceof Uint8Array
						? new Uint8Array(eventData.data)
						: new Uint8Array([]),
				timestamp: Date.now(),
			};
		} else if (eventData.layer === "xmpp_node") {
			event = {
				...(eventData as Omit<
					Extract<NetworkEvent, { layer: "xmpp_node" }>,
					"timestamp"
				>),
				data: deepClone(eventData.data) as Extract<
					NetworkEvent,
					{ layer: "xmpp_node" }
				>["data"],
				timestamp: Date.now(),
			};
		} else {
			throw new Error(
				`Unknown network event layer: ${(eventData as any).layer}`,
			);
		}
		this.dataStore.addNetworkEvent(event);
	}

	public recordClientEvent(
		eventName: string,
		payload: unknown,
		sourceComponent: string,
	): void {
		const event: ClientEventRecord = {
			eventName,
			payload: deepClone(payload),
			sourceComponent,
			timestamp: Date.now(),
		};
		this.dataStore.addClientEvent(event);
	}

	public recordError(source: string, error: Error, context?: unknown): void;
	public recordError(
		source: string,
		message: string,
		stack?: string,
		context?: unknown,
	): void;
	public recordError(
		source: string,
		errorOrMessage: string | Error,
		stackOrContext?: string | unknown,
		context?: unknown,
	): void {
		let record: ErrorRecord;
		if (errorOrMessage instanceof Error) {
			record = {
				source,
				message: errorOrMessage.message,
				stack: errorOrMessage.stack,
				context: deepClone(stackOrContext),
				timestamp: Date.now(),
			};
		} else {
			record = {
				source,
				message: errorOrMessage,
				stack: typeof stackOrContext === "string" ? stackOrContext : undefined,
				context:
					typeof stackOrContext !== "string"
						? deepClone(stackOrContext)
						: deepClone(context),
				timestamp: Date.now(),
			};
		}
		this.dataStore.addError(record);
	}

	public recordComponentState(componentId: string, state: unknown): void {
		const snapshot: ComponentStateSnapshot = {
			componentId,
			state: deepClone(state),
			timestamp: Date.now(),
		};
		this.dataStore.addComponentStateSnapshot(snapshot);
	}

	public getNetworkLog(
		count?: number,
		filters?: {
			direction?: "send" | "receive";
			layer?: NetworkEvent["layer"];
		},
	): NetworkEvent[] {
		let events = this.dataStore.getNetworkEvents(count);
		if (filters) {
			if (filters.direction) {
				events = events.filter((e) => e.direction === filters.direction);
			}
			if (filters.layer) {
				events = events.filter((e) => e.layer === filters.layer);
			}
		}
		return events;
	}

	public getClientEventLog(
		count?: number,
		filters?: { eventName?: string; sourceComponent?: string },
	): ClientEventRecord[] {
		let events = this.dataStore.getClientEvents(count);
		if (filters) {
			if (filters.eventName) {
				events = events.filter((e) => e.eventName === filters.eventName);
			}
			if (filters.sourceComponent) {
				events = events.filter(
					(e) => e.sourceComponent === filters.sourceComponent,
				);
			}
		}
		return events;
	}

	public getErrorLog(count?: number): ErrorRecord[] {
		return this.dataStore.getErrors(count);
	}

	public getComponentState(
		componentId: string,
	): ComponentStateSnapshot | undefined {
		return this.dataStore.getLatestComponentState(componentId);
	}

	public getComponentStateHistory(
		componentId: string,
		count?: number,
	): ComponentStateSnapshot[] {
		return this.dataStore.getComponentStateHistory(componentId, count);
	}

	public listMonitoredComponents(): string[] {
		return this.dataStore.getAllComponentIds();
	}

	public clearLogs(
		logType?: "network" | "events" | "errors" | "state" | "all",
		componentId?: string,
	): void {
		switch (logType) {
			case "network":
				this.dataStore.clearNetworkLog();
				break;
			case "events":
				this.dataStore.clearClientEvents();
				break;
			case "errors":
				this.dataStore.clearErrorLog();
				break;
			case "state":
				if (componentId) {
					this.dataStore.clearComponentStateHistory(componentId);
				} else {
					this.dataStore.clearAllComponentStates();
				}
				break;
			default:
				this.dataStore.clearAll();
				break;
		}
	}

	public async executeCoreCommand(
		targetComponent: string,
		command: string,
		_args: unknown[],
	): Promise<unknown> {
		if (!this.coreModules) {
			return Promise.reject(new Error("Core modules not available."));
		}
		console.warn(
			`[DebugController] executeCoreCommand for ${targetComponent}.${command} is not implemented.`,
		);
		return Promise.reject(
			new Error(
				`Command ${command} on ${targetComponent} not supported or component not found.`,
			),
		);
	}
}
