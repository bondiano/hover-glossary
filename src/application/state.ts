/**
 * hover-glossary / plugin state.
 *
 * One glossary service per HostContext instance: the WeakMap keeps two plugin
 * mounts in one process from sharing a store or a revision counter.
 */

import type { HostContext } from "../domain/types.js";
import {
	createGlossaryService,
	type GlossaryService,
} from "./glossary-service.js";

export interface PluginState {
	service: GlossaryService;
}

const instanceStates = new WeakMap<HostContext, PluginState>();

/** Retrieve or initialize the state of one HostContext instance. */
export function stateFor(ctx: HostContext): PluginState {
	let state = instanceStates.get(ctx);
	if (!state) {
		state = { service: createGlossaryService(ctx) };
		instanceStates.set(ctx, state);
	}
	return state;
}

/** Drop the state of one HostContext instance. */
export function disposePluginState(ctx: HostContext): void {
	instanceStates.delete(ctx);
}
