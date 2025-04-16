export class ProtocolAddress {
	id: string;
	deviceId: number;

	static from(encodedAddress: string): ProtocolAddress {
		if (!encodedAddress.match(/.*\.\d+/)) {
			throw new Error("Invalid address encoding");
		}
		const [id, deviceIdString] = encodedAddress.split(".");

		if (!id || !deviceIdString) {
			throw new Error("Invalid address encoding");
		}

		const deviceId = Number.parseInt(deviceIdString);

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
