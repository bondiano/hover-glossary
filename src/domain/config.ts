/**
 * hover-glossary / domain config.
 *
 * Every tunable in one place, plus the system-prompt guidance the model reads
 * before it decides to record a term.
 */

export const LIMITS = {
	/** Longest accepted term. */
	termChars: 80,
	/** Longest accepted gloss. */
	glossChars: 600,
	/** Longest accepted `kind`. */
	kindChars: 60,
	/** Longest accepted `source` reference. */
	sourceChars: 200,
	weightMin: 0,
	weightMax: 1000,
	/** Weight of a gloss the model did not rank. */
	defaultWeight: 100,
	/** Glosses kept per term, matching the seed tables. */
	maxEntriesPerTerm: 8,
	/** Terms returned by one `glossary_lookup` call. */
	lookupMatches: 20,
	/** Client refresh period while the tab is visible. */
	pollMs: 30_000,
} as const;

/** Same-origin route served by the Host half and polled by the browser half. */
export const LEXICON_ROUTE = "/plugin-api/hover-glossary/lexicon";

/**
 * System-prompt section for the tool surface. English, like the rest of the
 * tool descriptions; the glosses themselves are written in Russian.
 */
export const GLOSSARY_GUIDANCE = [
	"The tools `glossary_define` and `glossary_lookup` maintain the glossary behind the chat's hover tooltips.",
	"While reading project docs, README files, ADRs or domain material, record the terms a new reader of THIS project would not know: internal names, product nouns, abbreviations, configuration identifiers, domain vocabulary.",
	'Use `scope: "project"` (the default) for terms that only mean something in this repository; use `scope: "global"` only for domain vocabulary reusable across projects.',
	"Never record common words, generic programming terms a developer already knows, or one-off identifiers that never recur.",
	"Call `glossary_lookup` first: if the term already carries the meaning you want to record, skip it.",
	"Write the gloss in Russian, one sentence, self-contained, with the concrete meaning in this project.",
	"Keep `source` pointing at the doc that defines it (for example `README.md` or `docs/architecture.md`).",
	"Prefer several precise terms over many vague ones; the hover tooltip shows at most eight glosses per term.",
].join("\n");

/** Clip a value to a bounded, single-report string. */
export function clip(
	value: string | number | boolean | null | undefined,
	max: number,
): string {
	const text =
		typeof value === "string" ? value : value == null ? "" : String(value);
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 24))}\n… [truncated ${text.length - max} chars]`;
}

/** Message of anything that was thrown, for one-line reports. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Collapse whitespace and clip, for one-line log and tool lines. */
export function oneLine(
	value: string | number | boolean | null | undefined,
	max: number,
): string {
	return clip(
		(typeof value === "string" ? value : value == null ? "" : String(value))
			.replace(/\s+/g, " ")
			.trim(),
		max,
	);
}
