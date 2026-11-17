/**
 * hover-glossary / lexicon load machine.
 *
 * Startup is a two-layer read: the global store, then the project store that
 * sits next to the workspace. A store that cannot be read is skipped and named
 * in `quarantined`, so one broken file never costs the reader the whole
 * glossary. Actors are injected, so the machine is testable without a disk.
 */

import { assign, fromPromise, setup } from "xstate";
import { mergeTables } from "../lexicon.js";
import { SEED_TABLE } from "../seed.js";
import type { GlossaryEntry, GlossaryFile } from "../types.js";

export interface LexiconLoadInput {
	globalPath: string;
	/** Absent when the host has no project directory for this plugin instance. */
	projectPath?: string;
}

export interface LexiconLoadContext {
	globalPath: string;
	projectPath?: string;
	globalStore?: GlossaryFile;
	projectStore?: GlossaryFile;
	merged: Record<string, GlossaryEntry[]>;
	quarantined: string[];
}

export const lexiconLoadMachine = setup({
	types: {
		input: {} as LexiconLoadInput,
		context: {} as LexiconLoadContext,
		events: {} as { type: "" },
	},
	actors: {
		readStore: fromPromise<GlossaryFile, { path: string }>(async () => {
			throw new Error("readStore actor must be provided");
		}),
	},
	guards: {
		hasProjectStore: ({ context }) =>
			typeof context.projectPath === "string" && context.projectPath !== "",
	},
}).createMachine({
	id: "lexiconLoad",
	initial: "loadingGlobal",
	context: ({ input }) => ({
		globalPath: input.globalPath,
		projectPath: input.projectPath,
		merged: {},
		quarantined: [],
	}),
	states: {
		loadingGlobal: {
			invoke: {
				src: "readStore",
				input: ({ context }) => ({ path: context.globalPath }),
				onDone: {
					target: "loadingProject",
					actions: assign({ globalStore: ({ event }) => event.output }),
				},
				onError: {
					target: "loadingProject",
					actions: assign({
						quarantined: ({ context }) => [
							...context.quarantined,
							context.globalPath,
						],
					}),
				},
			},
		},
		loadingProject: {
			always: [
				{ guard: "hasProjectStore", target: "readingProject" },
				{ target: "ready" },
			],
		},
		readingProject: {
			invoke: {
				src: "readStore",
				input: ({ context }) => ({ path: context.projectPath as string }),
				onDone: {
					target: "ready",
					actions: assign({ projectStore: ({ event }) => event.output }),
				},
				onError: {
					target: "ready",
					actions: assign({
						quarantined: ({ context }) => [
							...context.quarantined,
							context.projectPath as string,
						],
					}),
				},
			},
		},
		ready: {
			type: "final",
			entry: assign({
				merged: ({ context }) =>
					mergeTables(
						SEED_TABLE,
						context.globalStore?.terms ?? {},
						context.projectStore?.terms ?? {},
					),
			}),
		},
	},
});
