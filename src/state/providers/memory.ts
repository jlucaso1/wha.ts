import type {
  AuthenticationCreds,
  IAuthStateProvider,
  ISignalProtocolStore,
  SignalDataTypeMap,
  SignalDataSet,
} from "../interface";
import { initAuthCreds } from "../utils";
import { Buffer } from "node:buffer";

// Simple deep clone function for objects with Buffers/Uint8Arrays
// JSON stringify/parse won't handle them correctly without reviver/replacer
const deepClone = <T>(obj: T): T => {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (obj instanceof Uint8Array || Buffer.isBuffer(obj)) {
    return Buffer.from(obj) as T; // Clone Buffers/Uint8Arrays
  }

  if (Array.isArray(obj)) {
    return obj.map(deepClone) as T;
  }

  const cloned = {} as T;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone(obj[key]);
    }
  }
  return cloned;
};

class MemorySignalKeyStore implements ISignalProtocolStore {
  // Store structure: Map<DataType, Map<ID, Data>>
  private store = new Map<keyof SignalDataTypeMap, Map<string, any>>();

  async get<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[]
  ): Promise<{ [id: string]: SignalDataTypeMap[T] | undefined }> {
    const typeStore = this.store.get(type);
    const results: { [id: string]: SignalDataTypeMap[T] | undefined } = {};
    if (typeStore) {
      for (const id of ids) {
        const value = typeStore.get(id);
        if (value !== undefined) {
          // Deep clone to prevent external modification of the stored object
          results[id] = deepClone(value) as SignalDataTypeMap[T];
        }
      }
    }
    return results;
  }

  async set(data: SignalDataSet): Promise<void> {
    for (const type in data) {
      if (!this.store.has(type as keyof SignalDataTypeMap)) {
        this.store.set(type as keyof SignalDataTypeMap, new Map());
      }
      const typeStore = this.store.get(type as keyof SignalDataTypeMap)!;
      const dataOfType = data[type as keyof SignalDataTypeMap];

      for (const id in dataOfType) {
        const value = dataOfType[id];
        if (value === null || value === undefined) {
          typeStore.delete(id);
        } else {
          // Deep clone before storing
          typeStore.set(id, deepClone(value));
        }
      }
    }
  }

  // Optional: Implement clear if needed
  // async clear(): Promise<void> {
  //     this.store.clear();
  // }
}

export class MemoryAuthState implements IAuthStateProvider {
  creds: AuthenticationCreds;
  keys: ISignalProtocolStore;

  constructor(creds?: AuthenticationCreds) {
    this.creds = creds || initAuthCreds();
    this.keys = new MemorySignalKeyStore();
    // TODO: Potentially load initial keys into the memory store if creds are passed
  }

  /** In-memory store doesn't need explicit saving, but fulfills the interface */
  async saveCreds(): Promise<void> {
    // console.log('MemoryAuthState: saveCreds called (no-op)');
    // No actual file writing needed for the memory store
  }
}
