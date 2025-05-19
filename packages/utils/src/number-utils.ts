// Utility functions for number parsing and manipulation

/**
 * Parses an optional integer from a string value.
 * @param value The string value to parse.
 * @param options.default The default value if parsing fails or value is undefined.
 * @param options.min Minimum allowed value.
 * @param options.max Maximum allowed value.
 * @returns The parsed number, the default value, or undefined if no default is provided and parsing fails.
 */
export function parseOptionalInt(
	value: string | undefined | null,
	options: { default?: number; min?: number; max?: number } = {},
): number | undefined {
	if (value === undefined || value === null || value.trim() === "") {
		return options.default;
	}
	let num = Number.parseInt(value, 10);

	if (Number.isNaN(num)) {
		return options.default;
	}

	if (options.min !== undefined) {
		num = Math.max(options.min, num);
	}
	if (options.max !== undefined) {
		num = Math.min(options.max, num);
	}
	return num;
}
