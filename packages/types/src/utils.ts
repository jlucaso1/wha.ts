import { randomBytes } from "@wha.ts/utils";

export const generateRegistrationId = (): number => {
	const random = randomBytes(2);

	const numbers = Uint16Array.from(random);

	const number = numbers[0];

	if (!number) {
		throw new Error("Failed to generate registration ID");
	}

	return number & 16383;
};

export const generateMdTagPrefix = () => {
	const bytes = randomBytes(4);

	const view = new DataView(bytes.buffer);
	const part1 = view.getUint16(0, false);
	const part2 = view.getUint16(2, false);

	return `${part1}.${part2}`;
};
