export * from "./controller";
export * from "./datastore";
export * from "./hooks";
export * from "./types";
export { startDebugREPL } from "./repl";
export { startDebugAPIServer } from "./api/server";

import { DebugController } from "./controller";
import type { DebugDataStoreOptions } from "./datastore";
import type { WhaTsCoreModules } from "./hooks";

/**
 * Initializes and returns a new DebugController instance.
 * Optionally attaches hooks if coreModules are provided.
 */
export function initDebugController(
	options?: DebugDataStoreOptions,
	coreModules?: WhaTsCoreModules,
): DebugController {
	const controller = new DebugController(options);
	if (coreModules) {
		controller.attachHooks(coreModules);
	}
	return controller;
}
