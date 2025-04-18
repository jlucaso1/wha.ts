export class ProtocolAddress {
	id: string;
	deviceId: number;

	static from(encoded: string) {
		const idx = encoded.lastIndexOf(".");
		if (idx < 1 || idx === encoded.length - 1)
			throw new Error("Invalid encoded address format");
		const id = encoded.slice(0, idx);
		const deviceId = Number(encoded.slice(idx + 1));
		if (!Number.isInteger(deviceId))
			throw new Error("Invalid device ID format");
		return new ProtocolAddress(id, deviceId);
	}

	constructor(id: string, deviceId: number) {
		if (typeof id !== "string") {
			throw new TypeError("id required for addr");
		}
		if (id.indexOf(".") !== -1) {
			throw new TypeError("encoded addr detected");
		}
		this.id = id;
		if (typeof deviceId !== "number") {
			throw new TypeError("number required for deviceId");
		}
		this.deviceId = deviceId;
	}

	toString(): string {
		return `${this.id}.${this.deviceId}`;
	}

	is(other: ProtocolAddress): boolean {
		return other.id === this.id && other.deviceId === this.deviceId;
	}
}
