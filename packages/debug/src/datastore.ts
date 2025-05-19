import type {
	ClientEventRecord,
	ComponentStateSnapshot,
	ErrorRecord,
	NetworkEvent,
} from "./types";

const DEFAULT_NETWORK_LOG_CAPACITY = 200;
const DEFAULT_CLIENT_EVENT_CAPACITY = 100;
const DEFAULT_ERROR_LOG_CAPACITY = 50;
const DEFAULT_STATE_SNAPSHOT_CAPACITY = 10; // Per component

class CircularBuffer<T> {
	private buffer: (T | undefined)[];
	private capacity: number;
	private head = 0; // Points to the next slot to write
	private tail = 0; // Points to the oldest item
	private _size = 0;

	constructor(capacity: number) {
		this.capacity = Math.max(1, capacity); // Ensure capacity is at least 1
		this.buffer = new Array(this.capacity).fill(undefined);
	}

	add(item: T): void {
		this.buffer[this.head] = item;
		this.head = (this.head + 1) % this.capacity;
		if (this._size < this.capacity) {
			this._size++;
		} else {
			this.tail = (this.tail + 1) % this.capacity; // Buffer was full, oldest item overwritten
		}
	}

	private getAllItemsOrdered(): T[] {
		const ordered: T[] = [];
		if (this._size === 0) return ordered;

		let current = this.tail;
		for (let i = 0; i < this._size; i++) {
			const item = this.buffer[current];
			if (item !== undefined) {
				ordered.push(item);
			}
			current = (current + 1) % this.capacity;
		}
		return ordered;
	}

	getItems(count?: number): T[] {
		const allItems = this.getAllItemsOrdered();
		if (count === undefined) {
			return allItems;
		}
		return allItems.slice(-Math.max(0, count));
	}

	get size(): number {
		return this._size;
	}

	clear(): void {
		this.buffer.fill(undefined);
		this.head = 0;
		this.tail = 0;
		this._size = 0;
	}
}

export interface DebugDataStoreOptions {
	networkLogCapacity?: number;
	clientEventCapacity?: number;
	errorLogCapacity?: number;
	stateSnapshotCapacity?: number;
}

export class DebugDataStore {
	private networkLog: CircularBuffer<NetworkEvent>;
	private clientEvents: CircularBuffer<ClientEventRecord>;
	private errorLog: CircularBuffer<ErrorRecord>;
	private componentStates: Map<string, CircularBuffer<ComponentStateSnapshot>>;
	private stateSnapshotCapacity: number;

	constructor(options?: DebugDataStoreOptions) {
		this.networkLog = new CircularBuffer(
			options?.networkLogCapacity ?? DEFAULT_NETWORK_LOG_CAPACITY,
		);
		this.clientEvents = new CircularBuffer(
			options?.clientEventCapacity ?? DEFAULT_CLIENT_EVENT_CAPACITY,
		);
		this.errorLog = new CircularBuffer(
			options?.errorLogCapacity ?? DEFAULT_ERROR_LOG_CAPACITY,
		);
		this.componentStates = new Map();
		this.stateSnapshotCapacity =
			options?.stateSnapshotCapacity ?? DEFAULT_STATE_SNAPSHOT_CAPACITY;
	}

	// Add methods
	addNetworkEvent(event: NetworkEvent): void {
		// Consider deep cloning or ensuring Uint8Array is copied if necessary
		// For now, assuming caller provides safe-to-store data or copies it.
		this.networkLog.add(event);
	}

	addClientEvent(event: ClientEventRecord): void {
		this.clientEvents.add(event);
	}

	addError(error: ErrorRecord): void {
		this.errorLog.add(error);
	}

	addComponentStateSnapshot(snapshot: ComponentStateSnapshot): void {
		if (!this.componentStates.has(snapshot.componentId)) {
			this.componentStates.set(
				snapshot.componentId,
				new CircularBuffer<ComponentStateSnapshot>(this.stateSnapshotCapacity),
			);
		}
		const buffer = this.componentStates.get(snapshot.componentId);
		if (buffer) {
			buffer.add(snapshot);
		}
	}

	// Get methods
	getNetworkEvents(count?: number): NetworkEvent[] {
		return this.networkLog.getItems(count);
	}

	getClientEvents(count?: number): ClientEventRecord[] {
		return this.clientEvents.getItems(count);
	}

	getErrors(count?: number): ErrorRecord[] {
		return this.errorLog.getItems(count);
	}

	getComponentStateHistory(
		componentId: string,
		count?: number,
	): ComponentStateSnapshot[] {
		const buffer = this.componentStates.get(componentId);
		return buffer ? buffer.getItems(count) : [];
	}

	getLatestComponentState(
		componentId: string,
	): ComponentStateSnapshot | undefined {
		const history = this.getComponentStateHistory(componentId, 1);
		return history.length > 0 ? history[0] : undefined;
	}

	getAllComponentIds(): string[] {
		return Array.from(this.componentStates.keys());
	}

	// Clear methods
	clearNetworkLog(): void {
		this.networkLog.clear();
	}

	clearClientEvents(): void {
		this.clientEvents.clear();
	}

	clearErrorLog(): void {
		this.errorLog.clear();
	}

	clearComponentStateHistory(componentId: string): void {
		this.componentStates.get(componentId)?.clear();
	}

	clearAllComponentStates(): void {
		for (const buffer of this.componentStates.values()) {
			buffer.clear();
		}
	}

	clearAll(): void {
		this.clearNetworkLog();
		this.clearClientEvents();
		this.clearErrorLog();
		this.clearAllComponentStates();
	}
}
