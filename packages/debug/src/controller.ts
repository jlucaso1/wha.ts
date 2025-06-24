import { DebugDataStore, type DebugDataStoreOptions } from "./datastore";
import { type WhaTsCoreModules, attachHooks, detachHooks } from "./hooks";
import type {
	ClientEventRecord,
	ComponentStateSnapshot,
	ErrorRecord,
	NetworkEvent,
} from "./types";

export const deepClone = (obj: any): any => {
	if (obj === null || typeof obj !== "object") {
		return obj;
	}
	if (obj instanceof Uint8Array) {
		return obj;
	}
	if (obj instanceof Date) {
		return new Date(obj.getTime());
	}
	if (Array.isArray(obj)) {
		return obj.map((item: any) => deepClone(item));
	}
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
		const event: NetworkEvent = {
			...eventData,
			data:
				eventData.data instanceof Uint8Array
					? eventData.data
					: deepClone(eventData.data),
			timestamp: Date.now(),
		};
		this.dataStore.addNetworkEvent(event);
	}

	public recordClientEvent(
		eventName: string,
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

	public recordError(source: string, error: Error, context?: any): void;
	public recordError(
		source: string,
		message: string,
		stack?: string,
		context?: any,
	): void;
	public recordError(
		source: string,
		errorOrMessage: string | Error,
		stackOrContext?: string | any,
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
		_args: any[],
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
