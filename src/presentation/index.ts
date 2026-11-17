/**
 * Hover glossary for DeepSeek Harness — Cordis plugin entrypoint.
 *
 * Two halves share one glossary: the Host half holds the merged table
 * (seed -> global -> project), exposes `glossary_define` / `glossary_lookup`
 * to the model, adds a system-prompt section that says when to record a term,
 * and serves the table on a read-only route. The browser half polls that route
 * and shows the glosses on hover. Store loading and term intake are explicit
 * XState v5 machines; the store schema is decoded with `effect`.
 *
 * @module hover-glossary/presentation
 */

import { registerLexiconRoute } from "../adapters/http.js";
import { buildTools, registerTool } from "../adapters/tools.js";
import { disposePluginState, stateFor } from "../application/state.js";
import { GLOSSARY_GUIDANCE } from "../domain/config.js";
import type { HostContext } from "../domain/types.js";

export { createGlossaryService } from "../application/glossary-service.js";
export {
	clip,
	GLOSSARY_GUIDANCE,
	LEXICON_ROUTE,
	LIMITS,
	oneLine,
} from "../domain/config.js";
export {
	createLexicon,
	displayTerm,
	isWordChar,
	Lexicon,
	mergeTables,
	normalize,
	tokenAt,
} from "../domain/lexicon.js";
export {
	lexiconLoadMachine,
	termIntakeMachine,
} from "../domain/machines/index.js";
export { SEED_TABLE } from "../domain/seed.js";
export { decodeStore } from "../domain/store-schema.js";
export {
	dshHome,
	emptyStore,
	globalStorePath,
	projectStorePath,
	readStore,
	writeStore,
} from "../infrastructure/glossary-store.js";
export { authenticatedWebServer } from "../infrastructure/web-route-auth.js";

/**
 * Services this plugin requires. `webServer` and `workingDirectory` are
 * optional and read with `ctx.get()`, so a minimal composition still loads.
 */
export const inject = ["tools", "systemPrompt"];

/** Fallback system-prompt order when `getSectionOrder` returns undefined. */
const FALLBACK_SUBAGENT_ORDER = 2800;

/** Install the glossary surface onto a Cordis HostContext. */
export function apply(ctx: HostContext): void {
	const { service } = stateFor(ctx);
	for (const tool of buildTools(service)) registerTool(ctx, tool);
	registerLexiconRoute(ctx, service);
	const order =
		typeof ctx.systemPrompt.getSectionOrder === "function"
			? (ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT") ??
					FALLBACK_SUBAGENT_ORDER) + 10
			: FALLBACK_SUBAGENT_ORDER + 10;
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: "tool:hover-glossary",
				order,
				text: GLOSSARY_GUIDANCE,
			}),
		"hover-glossary: prompt section",
	);
	ctx.effect(() => () => disposePluginState(ctx), "hover-glossary: dispose");
}
