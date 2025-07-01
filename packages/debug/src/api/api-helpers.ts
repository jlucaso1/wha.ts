import type { DebugController } from "../controller";
import { sanitizeObjectForJSON } from "./sanitize";

/**
 * Fetches a component's state and sanitizes it for JSON output.
 * @param controller The DebugController instance.
 * @param componentId The ID of the component.
 * @returns Sanitized state object or an error object if not found.
 */
export function getSanitizedComponentState(
	controller: DebugController,
	componentId: string,
): any {
	const snapshot = controller.getComponentState(componentId);
	if (snapshot) {
		return {
			timestamp: snapshot.timestamp,
			componentId: snapshot.componentId,
			state: sanitizeObjectForJSON(snapshot.state),
		};
	}
	return {
		error: "Component state not found",
		timestamp: Date.now(),
		componentId,
	};
}

export function getSanitizedComponentStateHistory(
	controller: DebugController,
	componentId: string,
	count?: number,
): any[] {
	const history = controller.getComponentStateHistory(componentId, count);
	return history.map((s) => ({
		...s,
		state: sanitizeObjectForJSON(s.state),
	}));
}
