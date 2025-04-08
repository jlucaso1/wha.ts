import type {
  AuthenticationCreds,
  IAuthStateProvider,
  ISignalProtocolStore,
  SignalDataSet,
  SignalDataTypeMap,
} from "../interface";
import { initAuthCreds } from "../utils";

const deepClone = <T>(obj: T): T => {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (obj instanceof Uint8Array) {
    return new Uint8Array(obj) as T;
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
  private store = new Map<keyof SignalDataTypeMap, Map<string, any>>();

  async get<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<{ [id: string]: SignalDataTypeMap[T] | undefined }> {
    const typeStore = this.store.get(type);
    const results: { [id: string]: SignalDataTypeMap[T] | undefined } = {};
    if (typeStore) {
      for (const id of ids) {
        const value = typeStore.get(id);
        if (value !== undefined) {
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
          typeStore.set(id, deepClone(value));
        }
      }
    }
  }
}

export class MemoryAuthState implements IAuthStateProvider {
  creds: AuthenticationCreds;
  keys: ISignalProtocolStore;

  constructor(creds?: AuthenticationCreds) {
    this.creds = creds || initAuthCreds();
    this.keys = new MemorySignalKeyStore();
  }

  async saveCreds(): Promise<void> {
  }
}
