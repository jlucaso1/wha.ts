import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseOptionalInt } from "@wha.ts/utils";
import { z } from "zod";
import type { DebugController } from "../controller";
import type { NetworkEvent } from "../types";
import {
	getSanitizedComponentState,
	getSanitizedComponentStateHistory,
} from "./api-helpers";
import { type JsonSerializable, sanitizeObjectForJSON } from "./sanitize";

// Type-safe sanitized network event type
type SanitizedNetworkEvent = Omit<NetworkEvent, "data"> & {
	data: JsonSerializable;
};

const sanitizeNetworkEventForJSON = (
	event: NetworkEvent,
): SanitizedNetworkEvent => ({
	...event,
	data: sanitizeObjectForJSON(event.data),
});

export function registerMcpHandlers(
	mcpServer: McpServer,
	controller: DebugController,
) {
	const MCP_PREFIX = "mcp://wha.ts-debug";

	// --- Resources ---

	mcpServer.resource(
		"logs-network",
		`${MCP_PREFIX}/logs/network`,
		{
			description:
				"Get network logs. Params: count (int), direction (send|receive), layer (websocket_raw|frame_raw|noise_payload|xmpp_node)",
		},
		async (uri: URL) => {
			const countParam = uri.searchParams.get("count");
			const count = parseOptionalInt(countParam, { min: 1 });
			const direction = uri.searchParams.get("direction") as
				| "send"
				| "receive"
				| undefined;
			const layer = uri.searchParams.get("layer") as
				| NetworkEvent["layer"]
				| undefined;

			const filters: {
				direction?: "send" | "receive";
				layer?: NetworkEvent["layer"];
			} = {};
			if (direction) filters.direction = direction;
			if (layer) filters.layer = layer;

			const events = controller
				.getNetworkLog(count, filters)
				.map(sanitizeNetworkEventForJSON);
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(events),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	mcpServer.resource(
		"logs-events",
		`${MCP_PREFIX}/logs/events`,
		{
			description:
				"Get client event logs. Params: count (int), name (string), source (string)",
		},
		async (uri: URL) => {
			const countParam = uri.searchParams.get("count");
			const count = parseOptionalInt(countParam, { min: 1 });
			const eventName = uri.searchParams.get("name") || undefined;
			const sourceComponent = uri.searchParams.get("source") || undefined;

			const filters: { eventName?: string; sourceComponent?: string } = {};
			if (eventName) filters.eventName = eventName;
			if (sourceComponent) filters.sourceComponent = sourceComponent;

			const events = controller.getClientEventLog(count, filters);
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(events),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	mcpServer.resource(
		"logs-errors",
		`${MCP_PREFIX}/logs/errors`,
		{ description: "Get error logs. Params: count (int)" },
		async (uri: URL) => {
			const countParam = uri.searchParams.get("count");
			const count = parseOptionalInt(countParam, { min: 1 });
			const errors = controller.getErrorLog(count);
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(errors),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	mcpServer.resource(
		"state-list",
		`${MCP_PREFIX}/state/list`,
		{ description: "List all components with tracked state." },
		async (uri: URL) => {
			const components = controller.listMonitoredComponents();
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(components),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	mcpServer.resource(
		"component-state",
		new ResourceTemplate(`${MCP_PREFIX}/state/{componentId}`, {
			list: undefined,
		}),
		{
			description:
				"Get the latest state of a specific component. Path param: componentId (string)",
		},
		async (uri: URL, variables: Record<string, unknown>) => {
			let componentId = variables.componentId;
			if (Array.isArray(componentId)) componentId = componentId[0];
			if (typeof componentId !== "string" || !componentId) {
				return {
					contents: [
						{
							uri: uri.href,
							text: JSON.stringify({ error: "Invalid or missing componentId" }),
							mimeType: "application/json",
						},
					],
				};
			}
			const sanitizedState = getSanitizedComponentState(
				controller,
				componentId,
			);
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(sanitizedState),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	// New resource for batch state retrieval
	mcpServer.resource(
		"batch-component-state",
		new ResourceTemplate(`${MCP_PREFIX}/state/batch/{componentIds}`, {
			list: undefined,
		}),
		{
			description:
				"Get the latest state of multiple components. Path param: componentIds (plus-separated string of componentIds, e.g., authenticator+noiseProcessor)",
		},
		async (uri: URL, variables: Record<string, unknown>) => {
			let componentIdsParam = variables.componentIds;
			if (Array.isArray(componentIdsParam))
				componentIdsParam = componentIdsParam[0];
			if (typeof componentIdsParam !== "string" || !componentIdsParam) {
				return {
					contents: [
						{
							uri: uri.href,
							text: JSON.stringify({
								error:
									"Missing or invalid 'componentIds' path parameter. Use /state/batch/{id1+id2}",
							}),
							mimeType: "application/json",
						},
					],
				};
			}

			const componentIds = componentIdsParam
				.split("+")
				.map((id: string) => id.trim())
				.filter((id: string) => id);
			if (componentIds.length === 0) {
				return {
					contents: [
						{
							uri: uri.href,
							text: JSON.stringify({
								error:
									"'componentIds' path parameter cannot be empty or only whitespace after trimming.",
							}),
							mimeType: "application/json",
						},
					],
				};
			}

			const results: Record<string, unknown> = {};

			for (const componentId of componentIds) {
				results[componentId] = getSanitizedComponentState(
					controller,
					componentId,
				);
			}

			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(results),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	mcpServer.resource(
		"component-state-history",
		new ResourceTemplate(`${MCP_PREFIX}/statehist/{componentId}`, {
			list: undefined,
		}),
		{
			description:
				"Get state history of a component. Path param: componentId (string). Query param: count (int)",
		},
		async (uri: URL, variables: Record<string, unknown>) => {
			let componentId = variables.componentId;
			if (Array.isArray(componentId)) componentId = componentId[0];
			if (typeof componentId !== "string" || !componentId) {
				return {
					contents: [
						{
							uri: uri.href,
							text: JSON.stringify({ error: "Invalid or missing componentId" }),
							mimeType: "application/json",
						},
					],
				};
			}
			const countParam = uri.searchParams.get("count");
			const count = parseOptionalInt(countParam, { default: 5, min: 1 });
			const history = getSanitizedComponentStateHistory(
				controller,
				componentId,
				count,
			);
			let textContent: string;
			if (history.length > 0) {
				textContent = JSON.stringify(history);
			} else {
				textContent = JSON.stringify({
					error: "Component state history not found",
				});
			}
			return {
				contents: [
					{
						uri: uri.href,
						text: textContent,
						mimeType: "application/json",
					},
				],
			};
		},
	);

	// --- Tools ---

	mcpServer.tool(
		"clear-logs",
		{
			type: z.enum(["network", "events", "errors", "state", "all"]),
			componentId: z
				.string()
				.optional()
				.describe(
					"Component ID, required if type is 'state' and clearing for a specific component.",
				),
		},
		async (args: {
			type: "network" | "events" | "errors" | "state" | "all";
			componentId?: string;
		}) => {
			if (args.type === "state" && !args.componentId) {
				// Ask to clear all component states
			} else if (args.type !== "state" && args.componentId) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "componentId is only applicable when type is 'state'.",
						},
					],
				};
			}
			controller.clearLogs(args.type, args.componentId);
			return {
				content: [
					{
						type: "text",
						text: `Cleared ${
							args.componentId
								? `${args.type} for ${args.componentId}`
								: args.type
						} logs/state.`,
					},
				],
			};
		},
	);

	// --- Signal protocol state resources ---

	// List all signal session component IDs
	mcpServer.resource(
		"signal-sessions-list",
		`${MCP_PREFIX}/state/signal/sessions`,
		{
			description:
				"Lists all protocol addresses with tracked Signal session state. The address can be used with /state/signal:session:{address} to get details.",
		},
		async (uri: URL) => {
			const allComponents = controller.listMonitoredComponents();
			const signalSessionComponentIds = allComponents.filter((id: string) =>
				id.startsWith("signal:session:"),
			);
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(signalSessionComponentIds),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	// Get the client's own Signal identity state
	mcpServer.resource(
		"signal-identity-state",
		`${MCP_PREFIX}/state/signal/identity`,
		{
			description:
				"Get the client's own Signal identity keys and registration ID.",
		},
		async (uri: URL) => {
			const componentId = "signal:identity";
			const snapshot = controller.getComponentState(componentId);
			let textContent: string;

			if (snapshot) {
				const sanitizedSnapshot = {
					...snapshot,
					state: sanitizeObjectForJSON(snapshot.state),
				};
				textContent = JSON.stringify(sanitizedSnapshot);
			} else {
				textContent = JSON.stringify({
					error: `State for '${componentId}' not found`,
				});
			}
			return {
				contents: [
					{
						uri: uri.href,
						text: textContent,
						mimeType: "application/json",
					},
				],
			};
		},
	);

	console.log("[MCP Debug Server] MCP Handlers registered.");
}
