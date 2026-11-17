/**
 * hover-glossary / store schema.
 *
 * The one place where `effect` inspects files that the plugin did not write:
 * a hand-edited or half-written `glossary.json` must not break the hover
 * surface, so the store is decoded against an explicit schema.
 */

import { Schema } from "effect";
import type { GlossaryFile } from "./types.js";

const EntrySchema = Schema.Struct({
	text: Schema.String,
	kind: Schema.optional(Schema.String),
	weight: Schema.optional(Schema.Number),
	tags: Schema.optional(Schema.Array(Schema.String)),
	scope: Schema.optional(Schema.Literals(["global", "project"])),
	source: Schema.optional(Schema.String),
});

const GlossaryFileSchema = Schema.Struct({
	version: Schema.Literal(1),
	terms: Schema.Record(Schema.String, Schema.Array(EntrySchema)),
});

const decodeFile = Schema.decodeResult(GlossaryFileSchema) as (
	input: unknown,
) =>
	| { _tag: "Success"; success: GlossaryFile }
	| { _tag: "Failure"; failure: { message: string } };

/** Decode one store, or explain why the bytes are not a store. */
export function decodeStore(
	input: unknown,
): { ok: true; value: GlossaryFile } | { ok: false; error: string } {
	const result = decodeFile(input);
	return result._tag === "Success"
		? { ok: true, value: result.success }
		: { ok: false, error: result.failure.message };
}
