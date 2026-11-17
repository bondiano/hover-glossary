/**
 * hover-glossary / glossary store.
 *
 * Two JSON files: one global glossary under `DSH_HOME`, one per project under
 * `<root>/.dsh/`. Reads tolerate anything a person may have typed into them:
 * unparsable or schema-invalid bytes are moved aside to
 * `glossary.json.corrupt-<timestamp>` and the layer reads as empty. Writes go
 * through a temporary file in the same directory, so a crash never leaves a
 * half-written glossary behind.
 */

import { Effect } from "effect";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { messageOf } from "../domain/config.js";
import { decodeStore } from "../domain/store-schema.js";
import type { GlossaryFile } from "../domain/types.js";

/** A store with no glosses; fresh object per call. */
export function emptyStore(): GlossaryFile {
	return { version: 1, terms: {} };
}

/** `DSH_HOME` at call time: tests set it per case, so it is never cached. */
export function dshHome(): string {
	const configured = process.env.DSH_HOME?.trim();
	return configured !== undefined && configured !== ""
		? configured
		: resolve(import.meta.dirname, "../../..");
}

/** Global store, shared by every project. */
export function globalStorePath(): string {
	return join(dshHome(), "data", "hover-glossary", "glossary.json");
}

/** Project store; committing it is how a team shares its vocabulary. */
export function projectStorePath(root: string): string {
	return join(root, ".dsh", "hover-glossary.json");
}

function isMissing(cause: unknown): boolean {
	return (
		cause !== null &&
		typeof cause === "object" &&
		"code" in cause &&
		cause.code === "ENOENT"
	);
}

async function quarantineStore(path: string, reason: string): Promise<void> {
	const target = `${path}.corrupt-${Date.now()}`;
	try {
		await rename(path, target);
	} catch (cause) {
		console.warn(
			`hover-glossary: ${path}: ${reason}; keeping it in place (${messageOf(cause)})`,
		);
		return;
	}
	console.warn(`hover-glossary: ${path}: ${reason}; moved to ${target}`);
}

/**
 * Read one store. A missing file is an empty layer; a corrupt one is moved
 * aside and also reads as empty, so the hover surface never goes dark.
 */
export async function readStore(path: string): Promise<GlossaryFile> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (cause) {
		if (isMissing(cause)) return emptyStore();
		throw new Error(`hover-glossary: cannot read ${path}: ${messageOf(cause)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	const decoded = decodeStore(parsed);
	if (!decoded.ok) {
		await quarantineStore(path, decoded.error);
		return emptyStore();
	}
	return decoded.value;
}

/** Write one store atomically: temporary sibling, then rename. */
export async function writeStore(
	path: string,
	file: GlossaryFile,
): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	await Effect.runPromise(
		Effect.tryPromise({
			try: async () => {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(
					temporary,
					`${JSON.stringify(file, null, "\t")}\n`,
					"utf8",
				);
				await rename(temporary, path);
			},
			catch: (cause) =>
				new Error(`hover-glossary: cannot write ${path}: ${messageOf(cause)}`),
		}),
	);
}
