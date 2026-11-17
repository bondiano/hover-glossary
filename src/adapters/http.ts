/**
 * hover-glossary / browser route.
 *
 * Read-only by construction: the browser polls the merged glossary, and the
 * only writer is the model through `glossary_define`.
 */

import type { GlossaryService } from "../application/glossary-service.js";
import { LEXICON_ROUTE } from "../domain/config.js";
import type { HostContext } from "../domain/types.js";
import { authenticatedWebServer } from "../infrastructure/web-route-auth.js";

/** Serve `LEXICON_ROUTE` for the browser half. */
export function registerLexiconRoute(
	ctx: HostContext,
	service: GlossaryService,
): void {
	ctx.inject(["webServer"], (routeCtx) => {
		const server = authenticatedWebServer(routeCtx, routeCtx.get("webServer"));
		if (!server) return;
		routeCtx.effect(
			() =>
				server.register({
					kind: "exact",
					path: LEXICON_ROUTE,
					handler: async (request, response) => {
						if ((request.method ?? "GET").toUpperCase() !== "GET") {
							response.writeHead(405, {
								"content-type": "text/plain; charset=utf-8",
								"cache-control": "no-store",
								allow: "GET",
							});
							response.end("method not allowed");
							return;
						}
						await service.whenReady();
						response.writeHead(200, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store",
						});
						response.end(JSON.stringify(service.snapshot()));
					},
				}),
			"hover-glossary: lexicon route",
		);
	});
}
