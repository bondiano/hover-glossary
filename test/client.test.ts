import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { createLexicon } from "../src/domain/lexicon.js";
import { SEED_TABLE } from "../src/domain/seed.js";

const SOURCE = readFileSync(
	fileURLToPath(new URL("../client.js", import.meta.url)),
	"utf8",
);

/** A macrotask boundary: every pending microtask has settled. */
async function flush(): Promise<void> {
	await delay(0);
}

type Listener = (event: unknown) => void;

interface ClientContext {
	slots: {
		inject(name: string, factory: () => (() => void) | void): void;
		register(
			options: { name: string; id: string; order: number },
			component: () => unknown,
		): () => void;
	};
	effect(callback: () => unknown, label?: string): unknown;
}

interface ClientPlugin {
	inject: string[];
	apply(ctx: ClientContext): void;
}

interface LoadedModule {
	id: string;
	factory(require: (id: string) => unknown): ClientPlugin;
}

interface Booted {
	plugin: ClientPlugin;
	components: Array<() => unknown>;
	effects: Array<() => void>;
	/** Move the caret to `at` and fire mousemove. */
	hover(at: number): void;
	fireDocument(type: string): void;
	intervals: Array<{ ms: number }>;
	cleared: unknown[];
	diagnostics(): Record<string, unknown> | undefined;
	liveStyles(): number;
	start(): void;
}

const react = {
	Fragment: "Fragment",
	createElement(
		type: unknown,
		props: Record<string, unknown> | null,
		...children: unknown[]
	) {
		return { type, props, children };
	},
	useState<T>(initial: T): [T, (next: T) => void] {
		return [initial, () => {}];
	},
	useEffect(callback: () => unknown): void {
		callback();
	},
};

function texts(node: unknown, out: string[] = []): string[] {
	if (typeof node === "string") out.push(node);
	else if (Array.isArray(node)) for (const child of node) texts(child, out);
	else if (node !== null && typeof node === "object") {
		if ("type" in node && typeof node.type === "function")
			texts(node.type("props" in node ? node.props : undefined), out);
		else if ("children" in node) {
			const children = node.children;
			if (Array.isArray(children))
				for (const child of children) texts(child, out);
		}
	}
	return out;
}

/** Boot the compiled browser half in a VM with a fake DOM, React and clock. */
function boot(text: string, nextSnapshot: () => Promise<unknown>): Booted {
	const body: Record<string, unknown> = {};
	const conversation: Record<string, unknown> = {
		tagName: "div",
		className: "dsh-chat",
		parentElement: body,
		getAttribute: (name: string) =>
			name === "data-chat-flow-kind" ? "assistant-step" : null,
	};
	const span: Record<string, unknown> = {
		tagName: "span",
		className: "",
		parentElement: conversation,
		getAttribute: () => null,
	};
	const textNode = { nodeType: 3, data: text, parentElement: span };
	const caret = { at: 0 };
	const documentListeners = new Map<string, Listener[]>();
	const windowListeners = new Map<string, Listener[]>();
	const styles: Array<{ removed: boolean }> = [];
	const intervals: Array<{ ms: number }> = [];
	const cleared: unknown[] = [];
	let pseudoClock = 0;
	let loaded: LoadedModule | undefined;

	class Clock extends Date {
		static override now(): number {
			pseudoClock += 100;
			return pseudoClock;
		}
	}

	const add = (
		map: Map<string, Listener[]>,
		type: string,
		listener: Listener,
	): void => {
		const list = map.get(type) ?? [];
		list.push(listener);
		map.set(type, list);
	};
	const remove = (
		map: Map<string, Listener[]>,
		type: string,
		listener: Listener,
	): void => {
		map.set(
			type,
			(map.get(type) ?? []).filter((candidate) => candidate !== listener),
		);
	};

	const sandbox: Record<string, unknown> = {
		window: {
			innerWidth: 1200,
			innerHeight: 800,
			addEventListener: (type: string, listener: Listener) =>
				add(windowListeners, type, listener),
			removeEventListener: (type: string, listener: Listener) =>
				remove(windowListeners, type, listener),
			__ModuleLoader__: {
				load(module: LoadedModule) {
					loaded = module;
				},
			},
		},
		document: {
			body,
			documentElement: {},
			visibilityState: "visible",
			elementFromPoint: () => span,
			caretRangeFromPoint: () => ({
				startContainer: textNode,
				startOffset: caret.at,
			}),
			createRange: () => ({
				setStart() {},
				setEnd() {},
				getClientRects: () => [{ left: 0, right: 1000, top: 0, bottom: 1000 }],
			}),
			createElement: () => {
				const style = {
					textContent: "",
					dataset: {} as Record<string, string>,
					removed: false,
					remove() {
						style.removed = true;
					},
				};
				styles.push(style);
				return style;
			},
			head: { append() {} },
			addEventListener: (type: string, listener: Listener) =>
				add(documentListeners, type, listener),
			removeEventListener: (type: string, listener: Listener) =>
				remove(documentListeners, type, listener),
		},
		console: { log() {}, debug() {}, warn() {}, error() {} },
		fetch: async () => ({ ok: true, json: nextSnapshot }),
		Date: Clock,
		setInterval: (_callback: () => void, ms: number) => {
			intervals.push({ ms });
			return intervals.length;
		},
		clearInterval: (id: unknown) => {
			cleared.push(id);
		},
	};
	createContext(sandbox);
	runInContext(SOURCE, sandbox);
	assert.ok(loaded, "the loader registered the plugin module");

	const components: Array<() => unknown> = [];
	const effects: Array<() => void> = [];
	const plugin = loaded.factory(() => react);

	return {
		plugin,
		components,
		effects,
		hover(at: number) {
			caret.at = at;
			for (const listener of documentListeners.get("mousemove") ?? [])
				listener({ clientX: 10, clientY: 10 });
		},
		fireDocument(type: string) {
			for (const listener of documentListeners.get(type) ?? []) listener({});
		},
		intervals,
		cleared,
		diagnostics: () =>
			(sandbox.window as Record<string, unknown>).__hoverGlossaryDiag__ as
				| Record<string, unknown>
				| undefined,
		liveStyles: () => styles.filter((style) => !style.removed).length,
		start() {
			plugin.apply({
				slots: {
					inject(_name, factory) {
						factory();
					},
					register(_options, component) {
						components.push(component);
						return () => {};
					},
				},
				effect(callback) {
					const dispose = callback();
					if (typeof dispose === "function") effects.push(() => void dispose());
					return () => {};
				},
			});
		},
	};
}

test("the browser half is a classic script the loader can evaluate", () => {
	assert.equal(/^(?:import|export)\b/m.test(SOURCE), false);
	assert.equal(/\bimport\s*\(/.test(SOURCE), false);
	assert.match(SOURCE, /__ModuleLoader__\.load\(/);
});

const SEED_SNAPSHOT = {
	ok: true,
	revision: 1,
	terms: {
		WHO: [{ text: "ВОЗ", kind: "аббр." }],
		API: [{ text: "интерфейс прикладного программирования" }],
		"United Nations": [{ text: "Организация Объединённых Наций" }],
	},
};

test("a fetched snapshot drives the hover tip", async () => {
	const booted = boot("Мы использовали WHO и API.", async () => SEED_SNAPSHOT);
	booted.start();
	await flush();

	assert.equal(booted.intervals.length, 1);
	assert.equal(booted.intervals[0]?.ms, 30_000);
	assert.equal(booted.liveStyles(), 1);
	assert.equal(booted.plugin.inject.join(","), "slots");

	const tip = booted.components[0];
	assert.ok(tip, "the overlay slot was registered");

	booted.hover("Мы использовали WHO и API.".indexOf("WHO") + 1);
	const shown = texts(tip());
	assert.equal(shown[0], "WHO", "the tip names the hovered term");
	assert.equal(shown[1], "1 значение");
	assert.equal(shown[2], "ВОЗ");

	assert.equal(booted.diagnostics()?.revision, 1);
	assert.equal(booted.diagnostics()?.terms, 3);
});

test("the same revision keeps the index, a new one replaces the table", async () => {
	const snapshots = [
		{ ...SEED_SNAPSHOT },
		{ ok: true, revision: 1, terms: {} },
		{
			ok: true,
			revision: 2,
			terms: { WHO: [{ text: "Всемирная организация здравоохранения" }] },
		},
	];
	let call = 0;
	const booted = boot("WHO", async () => snapshots[Math.min(call++, 2)]);
	booted.start();
	await flush();
	const tip = booted.components[0];
	assert.ok(tip);

	booted.hover(1);
	assert.equal(texts(tip())[2], "ВОЗ");

	// Same revision, different bytes: the built index must survive.
	booted.fireDocument("visibilitychange");
	await flush();
	booted.hover(1);
	assert.equal(texts(tip())[2], "ВОЗ", "an unchanged revision keeps the index");

	booted.fireDocument("visibilitychange");
	await flush();
	booted.hover(1);
	assert.equal(texts(tip())[2], "Всемирная организация здравоохранения");
	assert.equal(booted.diagnostics()?.revision, 2);

	for (const dispose of booted.effects) dispose();
	assert.equal(booted.cleared.length, 1, "the poll is stopped on dispose");
	assert.equal(booted.liveStyles(), 0);
	assert.deepEqual(texts(tip()), [], "the tip closes on dispose");
});

test("the bundled lookup matches the domain lexicon on every cursor position", async () => {
	const text =
		"Мы использовали API, WHO и токенизатор в DSH; псевдотокен не в счёт, United Nations тоже.";
	const booted = boot(text, async () => ({
		ok: true,
		revision: 1,
		terms: SEED_TABLE,
	}));
	booted.start();
	await flush();
	const tip = booted.components[0];
	assert.ok(tip);

	const domain = createLexicon(SEED_TABLE);
	const WORD = /[\p{L}\p{N}]/u;
	const isWord = (index: number) =>
		index >= 0 && index < text.length && WORD.test(text[index] ?? "");
	let hits = 0;
	for (let cursor = 0; cursor <= text.length; cursor += 1) {
		booted.hover(cursor);
		const shown = texts(tip());
		// `charAtPoint` resolves the caret to a glyph, preferring the character just
		// left of it; the tip must then agree with the domain lexicon at that glyph.
		const at = isWord(cursor - 1) ? cursor - 1 : isWord(cursor) ? cursor : -1;
		const expected = at < 0 ? null : domain.lookupAt(text, at);
		if (!expected || expected.entries.length === 0) {
			assert.deepEqual(shown, [], `cursor ${cursor} shows nothing`);
			continue;
		}
		hits += 1;
		assert.equal(shown[0], expected.term, `cursor ${cursor} names one term`);
		assert.equal(
			shown[2],
			expected.entries[0]?.text,
			`cursor ${cursor} shows one first gloss`,
		);
	}
	assert.ok(hits > 20, "the parity walk exercised real matches");
});
