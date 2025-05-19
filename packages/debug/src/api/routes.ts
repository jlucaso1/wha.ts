import { bytesToBase64 } from "@wha.ts/utils/src/bytes-utils";
import type { Request, Response } from "express";
import type { DebugController } from "../controller";
import type { NetworkEvent } from "../types";

// Helper to make network event data JSON serializable
const sanitizeNetworkEventForJSON = (event: NetworkEvent): NetworkEvent => {
	const sanitizedEvent = { ...event };
	if (event.data instanceof Uint8Array) {
		sanitizedEvent.data = bytesToBase64(event.data);
	}
	return sanitizedEvent;
};

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export function registerDebugRoutes(app: any, controller: DebugController) {
	app.get("/logs/network", (req: Request, res: Response) => {
		const count = req.query.count
			? Number.parseInt(req.query.count as string, 10)
			: 20;
		const direction = req.query.direction as "send" | "receive" | undefined;
		const layer = req.query.layer as NetworkEvent["layer"] | undefined;
		const filters: {
			direction?: "send" | "receive";
			layer?: NetworkEvent["layer"];
		} = {};
		if (direction) filters.direction = direction;
		if (layer) filters.layer = layer;

		const events = controller
			.getNetworkLog(count, filters)
			.map(sanitizeNetworkEventForJSON);
		res.json(events);
	});

	app.get("/logs/events", (req: Request, res: Response) => {
		const count = req.query.count
			? Number.parseInt(req.query.count as string, 10)
			: 20;
		const eventName = req.query.name as string | undefined;
		const sourceComponent = req.query.source as string | undefined;
		const filters: { eventName?: string; sourceComponent?: string } = {};
		if (eventName) filters.eventName = eventName;
		if (sourceComponent) filters.sourceComponent = sourceComponent;

		const events = controller.getClientEventLog(count, filters);
		res.json(events);
	});

	app.get("/logs/errors", (req: Request, res: Response) => {
		const count = req.query.count
			? Number.parseInt(req.query.count as string, 10)
			: 10;
		const errors = controller.getErrorLog(count);
		res.json(errors);
	});

	app.get("/state/list", (_req: Request, res: Response) => {
		res.json(controller.listMonitoredComponents());
	});

	app.get("/state/:componentId", (req: Request, res: Response) => {
		const { componentId } = req.params;
		if (!componentId) {
			return res.status(400).json({ error: "Missing componentId" });
		}
		const state = controller.getComponentState(componentId);
		if (state) {
			return res.json(state);
		}
		return res.status(404).json({ error: "Component state not found" });
	});

	app.get("/statehist/:componentId", (req: Request, res: Response) => {
		const { componentId } = req.params;
		if (!componentId) {
			return res.status(400).json({ error: "Missing componentId" });
		}
		const count = req.query.count
			? Number.parseInt(req.query.count as string, 10)
			: 5;
		const history = controller.getComponentStateHistory(componentId, count);
		if (history.length > 0) {
			return res.json(history);
		}
		return res.status(404).json({ error: "Component state history not found" });
	});

	app.post("/clear", (req: Request, res: Response) => {
		const logType = req.body.type as
			| "network"
			| "events"
			| "errors"
			| "state"
			| "all"
			| undefined;
		const componentId = req.body.componentId as string | undefined;
		if (!logType) {
			return res.status(400).json({ error: "Missing 'type' in request body" });
		}
		controller.clearLogs(logType, componentId);
		return res.json({
			message: `Cleared ${
				componentId ? `${logType} for ${componentId}` : logType
			} logs/state.`,
		});
	});

	console.log("[DebugAPI] Routes registered.");
}
