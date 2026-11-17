/**
 * hover-glossary / browser-half declarations.
 *
 * Global, because `client.ts` must compile to a classic script: the DSH
 * module loader evaluates it without any module system, so the file may not
 * contain a top-level import or export.
 */

/** One gloss as served by the Host route. */
interface ClientEntry {
	text: string;
	kind?: string;
	scope?: "global" | "project";
	weight?: number;
	tags?: string[];
}

/** `/plugin-api/hover-glossary/lexicon` response. */
interface ClientSnapshot {
	ok: boolean;
	revision: number;
	terms: Record<string, ClientEntry[]>;
	counts?: { seed: number; global: number; project: number };
}

/** What the tip renders. */
interface ClientTipState {
	visible: boolean;
	term: string;
	entries: ClientEntry[];
	x: number;
	y: number;
}

/** React node type, resolved without turning `client.ts` into a module. */
type ClientNode = typeof import("react").ReactNode;

interface ClientSlots {
	inject(name: string, factory: () => () => void): void;
	register(
		options: { name: string; id: string; order: number },
		component: () => unknown,
	): () => void;
}

interface ClientContext {
	slots: ClientSlots;
	effect(callback: () => unknown, label?: string): unknown;
}

interface Window {
	__ModuleLoader__: {
		load(options: {
			id: string;
			factory(require: (id: "react") => typeof import("react")): {
				inject: string[];
				apply(ctx: ClientContext): void;
			};
		}): void;
	};
	/** Diagnostics written by `selfCheck`, readable from the console. */
	__hoverGlossaryDiag__?: Record<string, unknown>;
}
