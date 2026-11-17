/**
 * hover-glossary / domain lexicon.
 *
 * The plugin's core: term -> 1..N glosses plus the "word under the cursor"
 * algorithm. Decisions kept from v1:
 * 1. `Map<normalizedKey, Entry[]>`: the key is `normalize(term)`, the value is
 *    an ordered list the reader sees as "1) … 2) …".
 * 2. The index is bucketed by key length so a lookup walks from the longest
 *    candidate down and stops at the first hit.
 * 3. `tokenAt` expands from the cursor in both directions, so Cyrillic,
 *    Latin and mixed text work; CJK has no word boundaries.
 *
 * This module stays dependency-free: the browser half bundles a small copy of
 * the lookup part, and the seeded tables flow through `mergeTables`.
 */

import { LIMITS } from "./config.js";
import type { GlossaryEntry, GlossaryEntryInput } from "./types.js";

/* ── Text normalization ───────────────────────────────────────────────── */

const APOSTROPHES = /[\u2018\u2019\u02bc\u02b9`]/g;
const PUNCT_EDGE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
const CJK_SPACE =
	/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;
const WORD_CHAR =
	/[\p{L}\p{N}\p{M}\u2019\u02bc'\u05f3\u30fb\u30fc\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/u;
const BOUNDARY = /[\p{L}\p{N}_]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Reduce any spelling to the lookup key: `WHO` / `who` / `"who,"` -> `who`. */
export function normalize(input: unknown): string {
	if (typeof input !== "string") return "";
	let text = input.normalize("NFKC");
	text = text.replace(APOSTROPHES, "'");
	text = text.replace(/\s+/g, " ");
	// Spaces between ideographs are typographic noise; Russian phrases keep theirs.
	text = text.replace(CJK_SPACE, "");
	text = text.replace(PUNCT_EDGE, "");
	return text.toLowerCase();
}

/** Trim the displayed term only: outer whitespace goes, case stays. */
export function displayTerm(input: unknown): string {
	if (typeof input !== "string") return "";
	return input.replace(/\s+/g, " ").trim();
}

/* ── Cursor -> word ───────────────────────────────────────────────────── */

/** True for any letter/digit/combining mark or the typographic apostrophes. */
export function isWordChar(ch: unknown): boolean {
	if (typeof ch !== "string" || ch.length === 0) return false;
	return WORD_CHAR.test(ch);
}

export interface TokenAt {
	term: string;
	start: number;
	end: number;
}

/** The word `cursor` sits in or immediately after, or `null` between words. */
export function tokenAt(text: unknown, cursor: number): TokenAt | null {
	if (typeof text !== "string" || text.length === 0) return null;
	if (!Number.isFinite(cursor)) return null;
	let index = Math.max(0, Math.min(text.length, Math.trunc(cursor)));
	// A cursor right after a word counts as that word; a real space or
	// punctuation belongs to no word, and lookupAt decides whether to look left.
	if (index >= text.length) {
		if (index > 0 && isWordChar(text[index - 1])) index -= 1;
		else return null;
	} else if (!isWordChar(text[index])) {
		return null;
	}
	let start = index;
	let end = index + 1;
	while (start > 0 && isWordChar(text[start - 1])) start -= 1;
	while (end < text.length && isWordChar(text[end])) end += 1;
	return { term: text.slice(start, end), start, end };
}

/* ── Lexicon ──────────────────────────────────────────────────────────── */

/** A gloss after normalization: every optional field is materialized. */
interface StoredEntry extends GlossaryEntry {
	weight: number;
	tags: string[];
	kind: string;
	index: number;
}

export interface LexiconOptions {
	/** Glosses kept per term; unbounded by default. */
	maxEntriesPerTerm?: number;
}

export interface LookupHit {
	term: string;
	key: string;
	start: number;
	end: number;
	entries: GlossaryEntry[];
}

export interface ListedTerm {
	term: string;
	key: string;
	entries: GlossaryEntry[];
}

function copyEntry(entry: StoredEntry): GlossaryEntry {
	return { ...entry, tags: entry.tags.slice() };
}

/** Index of term -> ordered glosses, with longest-match cursor lookup. */
export class Lexicon {
	readonly entries = new Map<string, StoredEntry[]>();
	/** Normalized key -> displayed term (case preserved). */
	readonly display = new Map<string, string>();
	/** Key length -> keys, so a lookup only tries plausible lengths. */
	readonly byLength = new Map<number, Set<string>>();
	/** Registration order, for a deterministic listing. */
	readonly order: string[] = [];
	maxKeyLength = 0;
	readonly maxEntriesPerTerm: number;

	constructor(options: LexiconOptions = {}) {
		this.maxEntriesPerTerm =
			Number.isFinite(options.maxEntriesPerTerm) &&
			(options.maxEntriesPerTerm as number) > 0
				? Math.trunc(options.maxEntriesPerTerm as number)
				: Number.POSITIVE_INFINITY;
	}

	get size(): number {
		return this.entries.size;
	}

	get itemCount(): number {
		let count = 0;
		for (const list of this.entries.values()) count += list.length;
		return count;
	}

	/** Register 1..N glosses of one term; returns `this` for chaining. */
	add(
		term: string,
		items: Array<string | GlossaryEntryInput>,
		options: { replace?: boolean } = {},
	): this {
		const key = normalize(term);
		if (key.length === 0) return this;
		const incoming: StoredEntry[] = [];
		for (const raw of Array.isArray(items) ? items : [items]) {
			const entry = typeof raw === "string" ? { text: raw } : raw;
			if (!entry || typeof entry.text !== "string") continue;
			const text = displayTerm(entry.text);
			if (text.length === 0) continue;
			incoming.push({
				text,
				kind: typeof entry.kind === "string" ? entry.kind : "толкование",
				weight: Number.isFinite(entry.weight) ? (entry.weight as number) : 0,
				tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
				index: 0,
				...(entry.scope === undefined ? {} : { scope: entry.scope }),
				...(typeof entry.source === "string" ? { source: entry.source } : {}),
			});
		}
		if (incoming.length === 0) return this;

		const existing =
			options.replace === true ? [] : (this.entries.get(key) ?? []);
		const merged = existing.concat(incoming).slice(0, this.maxEntriesPerTerm);
		// Stable sort: only by weight, insertion order wins on ties.
		merged.sort((left, right) => right.weight - left.weight);
		merged.forEach((entry, index) => {
			entry.index = index + 1;
		});

		if (!this.entries.has(key)) {
			this.order.push(key);
			const bucket = this.byLength.get(key.length);
			if (bucket) bucket.add(key);
			else this.byLength.set(key.length, new Set([key]));
			if (key.length > this.maxKeyLength) this.maxKeyLength = key.length;
		}
		this.entries.set(key, merged);
		this.display.set(key, displayTerm(term));
		return this;
	}

	/** Load a whole `{ term: [glosses] }` table. */
	load(table: Record<string, GlossaryEntryInput[]>): this {
		for (const term of Object.keys(table)) this.add(term, table[term] ?? []);
		return this;
	}

	has(keyOrTerm: string): boolean {
		return this.entries.has(normalize(keyOrTerm));
	}

	/** Glosses of one term, as copies the caller cannot corrupt. */
	lookup(term: unknown): GlossaryEntry[] {
		const list = this.entries.get(normalize(term));
		if (!list) return [];
		return list.map(copyEntry);
	}

	/** Word under the cursor and its glosses, preferring the longest match. */
	lookupAt(
		text: string,
		cursor: number,
		options: { window?: number } = {},
	): LookupHit {
		// Read-ahead window: the longest key in the lexicon by default;
		// a fixed 16 would cut long Russian phrases.
		const span = Number.isFinite(options.window)
			? (options.window as number)
			: this.maxKeyLength > 0
				? this.maxKeyLength
				: 16;
		let hit = tokenAt(text, cursor);
		// No word under the cursor:
		//  1) a space right after a word -> stay on that word;
		//  2) empty space between spaces -> walk right, never guess left;
		//  3) punctuation right after a word -> stay on the left word.
		if (!hit) {
			const position = Math.max(
				0,
				Math.min(text.length, Math.trunc(cursor || 0)),
			);
			const previous = position > 0 ? text[position - 1] : "";
			const next = text[position];
			const staysLeft =
				(previous === " " || previous === "\t" || !isWordChar(next)) &&
				isWordChar(previous);
			if (staysLeft) {
				const left = tokenAt(text, position - 1);
				if (left) hit = left;
			}
			if (!hit) {
				let scan = position;
				while (scan < text.length && !isWordChar(text[scan])) scan += 1;
				if (scan < text.length) return this.lookupAt(text, scan, options);
			}
		}
		const cursorPosition = Math.max(
			0,
			Math.min(text.length, Math.trunc(cursor || 0)),
		);
		const tokenStart = hit ? Math.min(hit.start, cursorPosition) : 0;
		const anchored = hit !== null;
		// Candidate starts run from the first token character to the cursor: the
		// left walk is what finds a CJK word inside a long run of ideographs.
		const starts: number[] = [];
		if (anchored) {
			for (let start = tokenStart; start <= cursorPosition; start += 1)
				starts.push(start);
		}
		if (starts.length === 0) starts.push(cursorPosition);
		const candidates: Array<{ key: string; start: number; end: number }> = [];
		for (const start of starts) {
			// A start reads right by at most the longest key, but the token under
			// the cursor is read to its end, or inner CJK words get cut off.
			const tokenEnd = hit && start === tokenStart ? hit.end : 0;
			const stop = Math.min(
				text.length,
				Math.max(tokenEnd, start + Math.max(1, span)),
			);
			let sawWordChar = false;
			for (let end = start + 1; end <= stop; end += 1) {
				const ch = text[end - 1];
				if (isWordChar(ch)) {
					sawWordChar = true;
					// A candidate must cover the cursor, or it is a fragment on the left.
					if (end > cursorPosition)
						candidates.push({
							key: normalize(text.slice(start, end)),
							start,
							end,
						});
					continue;
				}
				if (
					sawWordChar &&
					(ch === " " || ch === "\t") &&
					end < text.length &&
					isWordChar(text[end])
				)
					continue;
				break;
			}
		}

		candidates.sort(
			(left, right) =>
				right.end - right.start - (left.end - left.start) ||
				left.start - right.start,
		);
		for (const candidate of candidates) {
			const list = this.entries.get(candidate.key);
			if (list && list.length > 0) {
				// Latin/Cyrillic words need word boundaries: WHO must not fire inside
				// WHOLE, «токен» not inside «токенизатор». Ideographs have none.
				if (blocksWordBoundary(text, candidate.start, candidate.end)) continue;
				return {
					term: text.slice(candidate.start, candidate.end),
					key: candidate.key,
					start: candidate.start,
					end: candidate.end,
					entries: list.map(copyEntry),
				};
			}
		}
		// Fallback: the whole word under the cursor.
		if (hit) {
			const key = normalize(hit.term);
			const list = this.entries.get(key);
			if (list && list.length > 0)
				return {
					term: hit.term,
					key,
					start: hit.start,
					end: hit.end,
					entries: list.map(copyEntry),
				};
		}
		return {
			term: hit ? hit.term : "",
			key: "",
			start: cursorPosition,
			end: cursorPosition,
			entries: [],
		};
	}

	/** Every term in registration order. */
	list(): ListedTerm[] {
		return this.order.map((key) => ({
			term: this.display.get(key) ?? key,
			key,
			entries: this.lookup(key),
		}));
	}

	/** Structural self-check: length buckets and gloss numbering agree. */
	validate(): { ok: boolean; problems: string[] } {
		const problems: string[] = [];
		for (const key of this.order) {
			const list = this.entries.get(key);
			if (!list || list.length === 0) problems.push(`${key}: нет толкований`);
			else
				list.forEach((entry, index) => {
					if (entry.index !== index + 1)
						problems.push(
							`${key}: сбилась нумерация (${entry.index} != ${index + 1})`,
						);
				});
			const bucket = this.byLength.get(key.length);
			if (!bucket || !bucket.has(key))
				problems.push(`${key}: ключ не попал в корзину длины`);
		}
		if (this.maxKeyLength > 0 && !this.byLength.has(this.maxKeyLength))
			problems.push(`maxKeyLength=${this.maxKeyLength} без своей корзины`);
		return { ok: problems.length === 0, problems };
	}
}

/**
 * True when a match is part of a longer word. Applies to Latin and Cyrillic
 * letters and digits, never to ideographs: CJK has no explicit word boundary,
 * so a hit inside a run of text is normal there.
 */
function blocksWordBoundary(text: string, start: number, end: number): boolean {
	const blocks = (ch: string | undefined) =>
		typeof ch === "string" && BOUNDARY.test(ch) && !CJK.test(ch);
	if (blocks(text[start]) && start > 0 && blocks(text[start - 1])) return true;
	if (blocks(text[end - 1]) && end < text.length && blocks(text[end]))
		return true;
	return false;
}

/** Build a lexicon from a `{ term: [glosses] }` table. */
export function createLexicon(
	table: Record<string, GlossaryEntryInput[]>,
	options?: LexiconOptions,
): Lexicon {
	return new Lexicon(options).load(table);
}

/**
 * Merge the three store layers into the table the browser sees. Glosses are
 * concatenated seed -> global -> project, then sorted by weight and capped like
 * any other add; the `scope` marker of stored glosses survives.
 */
export function mergeTables(
	seed: Record<string, GlossaryEntryInput[]>,
	global: Record<string, GlossaryEntryInput[]>,
	project: Record<string, GlossaryEntryInput[]>,
): Record<string, GlossaryEntry[]> {
	const lexicon = new Lexicon({
		maxEntriesPerTerm: LIMITS.maxEntriesPerTerm,
	});
	for (const table of [seed, global, project])
		for (const term of Object.keys(table)) lexicon.add(term, table[term] ?? []);
	return Object.fromEntries(
		lexicon.list().map(({ term, entries }) => [term, entries]),
	);
}
