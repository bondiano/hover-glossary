/**
 * hover-glossary / glossary service.
 *
 * Owns the three merged layers, the revision the browser polls, and the single
 * write path. Mutations are serialized through one queue so two tool calls in
 * one turn can never interleave a read-modify-write on the same store.
 */

import { createActor, fromPromise, toPromise } from "xstate";
import { LIMITS } from "../domain/config.js";
import { displayTerm, mergeTables, normalize } from "../domain/lexicon.js";
import { lexiconLoadMachine } from "../domain/machines/lexicon-load.machine.js";
import { termIntakeMachine } from "../domain/machines/term-intake.machine.js";
import { SEED_TABLE } from "../domain/seed.js";
import type {
	Agent,
	GlossaryEntry,
	GlossaryEntryInput,
	GlossaryFile,
	GlossaryScope,
	HostContext,
	LexiconSnapshot,
} from "../domain/types.js";
import {
	emptyStore,
	globalStorePath,
	projectStorePath,
	readStore,
	writeStore,
} from "../infrastructure/glossary-store.js";

export interface DefineTermInput {
	term: string;
	scope: GlossaryScope;
	entry: GlossaryEntryInput;
}

export interface DefineTermOutcome {
	status: "defined" | "unchanged" | "failed";
	term: string;
	scope: GlossaryScope;
	entries: GlossaryEntry[];
	error?: string;
}

export interface LookupMatch {
	term: string;
	count: number;
}

export interface LookupOutcome {
	query: string;
	exact?: { term: string; entries: GlossaryEntry[] };
	matches: LookupMatch[];
}

export interface GlossaryService {
	/** Resolves once the stores have been read; routes await it before serving. */
	whenReady(): Promise<void>;
	/** Merged table plus revision, as served to the browser. */
	snapshot(): LexiconSnapshot;
	defineTerm(input: DefineTermInput, agent?: Agent): Promise<DefineTermOutcome>;
	lookup(query: string): Promise<LookupOutcome>;
}

function countTerms(file: GlossaryFile): number {
	return Object.keys(file.terms).length;
}

function createGlossaryService(ctx: HostContext): GlossaryService {
	const stores: Record<GlossaryScope, GlossaryFile> = {
		global: emptyStore(),
		project: emptyStore(),
	};
	let projectRoot: string | undefined;
	let merged: Record<string, GlossaryEntry[]> = {};
	let revision = 0;
	let queue: Promise<unknown> = Promise.resolve();

	/** Working directory of the calling session, when the host exposes one. */
	const rootOf = (agent?: Agent): string | undefined => {
		try {
			return ctx.get("workingDirectory")?.get(agent?.session);
		} catch {
			return undefined;
		}
	};

	const refresh = (scope: GlossaryScope, file: GlossaryFile): void => {
		stores[scope] = file;
		merged = mergeTables(SEED_TABLE, stores.global.terms, stores.project.terms);
		revision += 1;
	};

	const ready = (async () => {
		projectRoot = rootOf();
		const actor = createActor(
			lexiconLoadMachine.provide({
				actors: {
					readStore: fromPromise(
						async ({ input }: { input: { path: string } }) =>
							readStore(input.path),
					),
				},
			}),
			{
				input: {
					globalPath: globalStorePath(),
					projectPath:
						projectRoot === undefined
							? undefined
							: projectStorePath(projectRoot),
				},
			},
		);
		actor.start();
		await toPromise(actor);
		const snapshot = actor.getSnapshot().context;
		for (const path of snapshot.quarantined)
			ctx.logger?.warn?.(`hover-glossary: unusable store ${path}`);
		stores.global = snapshot.globalStore ?? emptyStore();
		stores.project = snapshot.projectStore ?? emptyStore();
		merged = snapshot.merged;
		revision = 1;
	})();

	/** Serialize mutations; a rejected job never blocks the next one. */
	const serialize = <T>(job: () => Promise<T>): Promise<T> => {
		const next = queue.then(job, job);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	const entriesOf = (term: string): GlossaryEntry[] => {
		const key = normalize(term);
		for (const candidate of Object.keys(merged))
			if (normalize(candidate) === key)
				return (merged[candidate] ?? []).map((entry) => ({
					...entry,
					tags: entry.tags ? entry.tags.slice() : [],
				}));
		return [];
	};

	async function define(
		input: DefineTermInput,
		agent?: Agent,
	): Promise<DefineTermOutcome> {
		await ready;
		const term = displayTerm(input.term);
		const scope = input.scope;
		if (scope === "project") {
			const root = rootOf(agent) ?? projectRoot;
			if (root === undefined)
				throw new Error(
					'hover-glossary: project scope unavailable here; pass scope "global"',
				);
			if (root !== projectRoot) {
				projectRoot = root;
				stores.project = await readStore(projectStorePath(root));
				refresh("project", stores.project);
			}
		}
		const path =
			scope === "project"
				? projectStorePath(projectRoot as string)
				: globalStorePath();
		const actor = createActor(
			termIntakeMachine.provide({
				actors: {
					persistStore: fromPromise(
						async ({
							input: step,
						}: {
							input: { path: string; file: GlossaryFile };
						}) => writeStore(step.path, step.file),
					),
					refreshSnapshot: fromPromise(
						async ({
							input: step,
						}: {
							input: { scope: GlossaryScope; file: GlossaryFile };
						}) => {
							refresh(step.scope, step.file);
						},
					),
				},
			}),
			{
				input: {
					target: stores[scope],
					scope,
					path,
					term,
					entry: input.entry,
				},
			},
		);
		actor.start();
		await toPromise(actor);
		const snapshot = actor.getSnapshot();
		const status =
			snapshot.value === "defined"
				? "defined"
				: snapshot.value === "unchanged"
					? "unchanged"
					: "failed";
		if (status !== "failed")
			return { status, term, scope, entries: entriesOf(term) };

		const error = snapshot.context.error ?? "unknown error";
		ctx.logger?.warn?.(`hover-glossary: ${term}: ${error}`);
		return { status, term, scope, entries: entriesOf(term), error };
	}

	return {
		async whenReady() {
			await ready;
		},

		snapshot() {
			return {
				ok: true,
				revision,
				terms: merged,
				counts: {
					seed: Object.keys(SEED_TABLE).length,
					global: countTerms(stores.global),
					project: countTerms(stores.project),
				},
			};
		},

		async defineTerm(input, agent) {
			await ready;
			return serialize(() => define(input, agent));
		},

		async lookup(query) {
			await ready;
			const key = normalize(query);
			const terms = Object.keys(merged);
			const exactTerm = terms.find((term) => normalize(term) === key);
			return {
				query,
				...(exactTerm === undefined
					? {}
					: { exact: { term: exactTerm, entries: entriesOf(exactTerm) } }),
				matches:
					key === ""
						? []
						: terms
								.filter((term) => normalize(term).includes(key))
								.slice(0, LIMITS.lookupMatches)
								.map((term) => ({
									term,
									count: (merged[term] ?? []).length,
								})),
			};
		},
	};
}

/** Kept next to the service so callers share one constructor. */
export { createGlossaryService };
