import assert from "node:assert/strict";
import test from "node:test";
import { createActor, fromPromise, toPromise } from "xstate";

import {
	lexiconLoadMachine,
	termIntakeMachine,
} from "../src/domain/machines/index.js";
import type { GlossaryFile } from "../src/domain/types.js";

const GLOBAL: GlossaryFile = {
	version: 1,
	terms: { GTERM: [{ text: "глобальный термин", scope: "global" }] },
};
const PROJECT: GlossaryFile = {
	version: 1,
	terms: { PTERM: [{ text: "проектный термин", scope: "project" }] },
};

test("lexiconLoad merges seed, global and project and reaches ready", async () => {
	const machine = lexiconLoadMachine.provide({
		actors: {
			readStore: fromPromise(async ({ input }) =>
				input.path.endsWith("global.json") ? GLOBAL : PROJECT,
			),
		},
	});
	const actor = createActor(machine, {
		input: { globalPath: "/tmp/global.json", projectPath: "/tmp/project.json" },
	});
	actor.start();
	await toPromise(actor);
	const snapshot = actor.getSnapshot();
	assert.equal(snapshot.value, "ready");
	assert.deepEqual(snapshot.context.quarantined, []);
	assert.equal(
		snapshot.context.globalStore?.terms.GTERM?.[0]?.text,
		"глобальный термин",
	);
	assert.equal(
		snapshot.context.projectStore?.terms.PTERM?.[0]?.text,
		"проектный термин",
	);
	// The seeded layers survive and the stored ones were added on top.
	assert.ok(Object.keys(snapshot.context.merged).length > 2);
	assert.equal(snapshot.context.merged.GTERM?.[0]?.text, "глобальный термин");
	assert.equal(snapshot.context.merged.WHO?.length, 2);
});

test("lexiconLoad skips an unreadable global store and still merges the rest", async () => {
	const quarantined: string[] = [];
	const machine = lexiconLoadMachine.provide({
		actors: {
			readStore: fromPromise(async ({ input }) => {
				if (input.path.endsWith("global.json")) {
					quarantined.push(input.path);
					throw new Error("unreadable store");
				}
				return PROJECT;
			}),
		},
	});
	const actor = createActor(machine, {
		input: { globalPath: "/tmp/global.json", projectPath: "/tmp/project.json" },
	});
	actor.start();
	await toPromise(actor);
	const snapshot = actor.getSnapshot();
	assert.equal(snapshot.value, "ready");
	assert.deepEqual(quarantined, ["/tmp/global.json"]);
	assert.deepEqual(snapshot.context.quarantined, ["/tmp/global.json"]);
	assert.equal(snapshot.context.globalStore, undefined);
	assert.equal(snapshot.context.merged.PTERM?.[0]?.text, "проектный термин");
	assert.equal(snapshot.context.merged.WHO?.length, 2);
});

test("lexiconLoad without a project path reads only the global layer", async () => {
	const paths: string[] = [];
	const machine = lexiconLoadMachine.provide({
		actors: {
			readStore: fromPromise(async ({ input }) => {
				paths.push(input.path);
				return GLOBAL;
			}),
		},
	});
	const actor = createActor(machine, {
		input: { globalPath: "/tmp/global.json" },
	});
	actor.start();
	await toPromise(actor);
	assert.equal(actor.getSnapshot().value, "ready");
	assert.deepEqual(paths, ["/tmp/global.json"]);
});

test("termIntake writes one gloss and refreshes the snapshot", async () => {
	const written: Array<{ path: string; file: GlossaryFile }> = [];
	const refreshed: string[] = [];
	const target: GlossaryFile = { version: 1, terms: {} };
	const actor = createActor(
		termIntakeMachine.provide({
			actors: {
				persistStore: fromPromise(async ({ input }) => {
					written.push(input);
				}),
				refreshSnapshot: fromPromise(async ({ input }) => {
					refreshed.push(input.scope);
				}),
			},
		}),
		{
			input: {
				target,
				scope: "project",
				path: "/tmp/project.json",
				term: "  TOKEN  ",
				entry: { text: "толкование", kind: "термин" },
			},
		},
	);
	actor.start();
	await toPromise(actor);
	const snapshot = actor.getSnapshot();
	assert.equal(snapshot.value, "defined");
	assert.deepEqual(refreshed, ["project"]);
	assert.equal(written.length, 1);
	assert.equal(written[0]?.path, "/tmp/project.json");
	assert.deepEqual(written[0]?.file.terms.TOKEN, [
		{ text: "толкование", kind: "термин", scope: "project" },
	]);
	assert.deepEqual(
		target.terms,
		{},
		"the loaded store is never mutated in place",
	);
});

test("termIntake leaves an existing gloss untouched", async () => {
	let persisted = false;
	const actor = createActor(
		termIntakeMachine.provide({
			actors: {
				persistStore: fromPromise(async () => {
					persisted = true;
				}),
				refreshSnapshot: fromPromise(async () => {}),
			},
		}),
		{
			input: {
				target: {
					version: 1,
					terms: { TOKEN: [{ text: "толкование" }] },
				},
				scope: "global",
				path: "/tmp/global.json",
				term: "TOKEN",
				entry: { text: "толкование" },
			},
		},
	);
	actor.start();
	await toPromise(actor);
	assert.equal(actor.getSnapshot().value, "unchanged");
	assert.equal(persisted, false, "a duplicate gloss costs no write");
});

test("termIntake reports a failed write instead of claiming success", async () => {
	const actor = createActor(
		termIntakeMachine.provide({
			actors: {
				persistStore: fromPromise(async (): Promise<void> => {
					throw new Error("disk is read-only");
				}),
				refreshSnapshot: fromPromise(async () => {}),
			},
		}),
		{
			input: {
				target: { version: 1, terms: {} },
				scope: "global",
				path: "/tmp/global.json",
				term: "T",
				entry: { text: "t" },
			},
		},
	);
	actor.start();
	await toPromise(actor);
	const snapshot = actor.getSnapshot();
	assert.equal(snapshot.value, "failed");
	assert.match(snapshot.context.error ?? "", /disk is read-only/);
});
