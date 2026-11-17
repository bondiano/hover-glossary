/** Shared helper for reading invoked XState actor `onError` payloads. */

export function actorError(event: unknown): unknown {
	return event !== null && typeof event === "object" && "error" in event
		? event.error
		: event;
}
