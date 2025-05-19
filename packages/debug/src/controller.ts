import { DebugDataStore, type DebugDataStoreOptions } from "./datastore";
import { type WhaTsCoreModules, attachHooks, detachHooks } from "./hooks";
import type {
	ClientEventRecord,
	ComponentStateSnapshot,
	ErrorRecord,
	NetworkEvent,
} from "./types";

// Utility to deep clone, good enough for most debug data
// For Uint8Array, it will become an object with numeric keys in JSON.stringify
// which is fine for inspection. If precise Uint8Array type is needed after JSON,
// it needs custom revival.
// For performance-critical paths, direct copying or more specialized cloning is better.
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
const deepClone = (obj: any): any => {
	if (obj === null || typeof obj !== "object") {
		return obj;
	}
	if (obj instanceof Uint8Array) {
		return new Uint8Array(obj); // Create a copy
	}
	if (obj instanceof Date) {
		return new Date(obj.getTime());
	}
	if (Array.isArray(obj)) {
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		return obj.map((item: any) => deepClone(item));
	}
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	const cloned: { [key: string]: any } = {};
	for (const key in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			cloned[key] = deepClone(obj[key]);
		}
	}
	return cloned;
};

export class DebugController {
	public dataStore: DebugDataStore;
	private coreModules?: WhaTsCoreModules;
	private isHooksAttached = false;

	constructor(options?: DebugDataStoreOptions) {
		this.dataStore = new DebugDataStore(options);
	}

	// --- Hook Management ---
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

	// --- Data Recording Methods (called by hooks) ---
	public recordNetworkEvent(eventData: Omit<NetworkEvent, "timestamp">): void {
		const event: NetworkEvent = {
			...eventData,
			data:
				eventData.data instanceof Uint8Array
					? new Uint8Array(eventData.data)
					: deepClone(eventData.data),
			timestamp: Date.now(),
		};
		this.dataStore.addNetworkEvent(event);
	}

	public recordClientEvent(
		eventName: string,
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		payload: any,
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

	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	public recordError(source: string, error: Error, context?: any): void;
	public recordError(
		source: string,
		message: string,
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		stack?: string,
		context?: any,
	): void;
	public recordError(
		source: string,
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		errorOrMessage: string | Error,
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		stackOrContext?: string | any,
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		context?: any,
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

	// --- Data Access Methods (for REPL/API) ---
	public getNetworkLog(
		count?: number,
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
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
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
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

	// Placeholder for potential direct command execution - USE WITH CAUTION
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	public async executeCoreCommand(
		targetComponent: string,
		command: string,
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		args: any[],
	): Promise<any> {
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
