/**
 * hover-glossary / plugin state.
 *
 * One glossary service per HostContext instance: the WeakMap keeps two plugin
 * mounts in one process from sharing a store or a revision counter.
 */
import { createGlossaryService, } from "./glossary-service.js";
const instanceStates = new WeakMap();
/** Retrieve or initialize the state of one HostContext instance. */
export function stateFor(ctx) {
    let state = instanceStates.get(ctx);
    if (!state) {
        state = { service: createGlossaryService(ctx) };
        instanceStates.set(ctx, state);
    }
    return state;
}
/** Drop the state of one HostContext instance. */
export function disposePluginState(ctx) {
    instanceStates.delete(ctx);
}
