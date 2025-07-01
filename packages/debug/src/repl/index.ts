import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import type { DebugController } from "../controller";
import { handleREPLCommand } from "./commands";

export async function startDebugREPL(controller: DebugController) {
	const rl = readline.createInterface({
		input,
		output,
		prompt: "wha.ts-debug> ",
	});
	console.log(
		"Wha.ts Debug REPL started. Type 'help' for commands, 'exit' to quit.",
	);

	rl.prompt();

	for await (const line of rl) {
		const trimmedLine = line.trim();
		if (trimmedLine.toLowerCase() === "exit") {
			break;
		}

		if (trimmedLine) {
			const [command, ...args] = trimmedLine.split(/\s+/);
			if (command) {
				const result = await handleREPLCommand(controller, command, args);
				console.log(result);
			}
		}
		rl.prompt();
	}

	rl.close();
	console.log("Exiting Wha.ts Debug REPL.");
	process.exit(0);
}
