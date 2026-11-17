import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { apply } from "../index.js";
import { SEED_TABLE } from "../src/domain/seed.js";
import { stateFor } from "../state.js";
import type {
	HostContext,
	HostServices,
	ToolDefinition,
	ToolExec,
	ToolValue,
	WebRoute,
	WebServer,
} from "../types.js";

interface DefinedValue extends ToolValue {
	status: string;
	term: string;
	scope: string;
	revision: number;
	entries: Array<{ text: string; scope?: string }>;
}

interface HostFixture {
	ctx: HostContext;
	tools: Map<string, ToolDefinition>;
	sections: Array<{ name: string; order: number; text: string }>;
	routes: WebRoute[];
	disposers: Array<() => void>;
}

/** Fake Host: only the seams this plugin consumes, no Cordis. */
function makeHost(projectRoot: string): HostFixture {
	const tools = new Map<string, ToolDefinition>();
	const sections: HostFixture["sections"] = [];
	const routes: WebRoute[] = [];
	const disposers: HostFixture["disposers"] = [];
	const server: WebServer = {
		getOrigin: () => "http://127.0.0.1:1234",
		register(route) {
			routes.push(route);
			return () => {};
		},
	};
	const services: Partial<HostServices> = {
		workingDirectory: { get: () => projectRoot },
		webServer: server,
	};
	const ctx = {
		get(name: keyof HostServices) {
			return services[name];
		},
		fiber: { entry: { options: { config: {} } } },
		effect(callback: () => unknown) {
			const dispose = callback();
			if (typeof dispose === "function") disposers.push(dispose as () => void);
			return () => {};
		},
		tools: {
			register(definition: ToolDefinition) {
				tools.set(definition.name, definition);
				return () => tools.delete(definition.name);
			},
		},
		systemPrompt: {
			getSectionOrder: () => 2800,
			section(section: { name: string; order: number; text: string }) {
				sections.push(section);
				return () => {};
			},
		},
		inject(deps: string[], callback: (context: HostContext) => void) {
			if (
				deps.every((name) => services[name as keyof HostServices] !== undefined)
			)
				callback(ctx as unknown as HostContext);
		},
	} as unknown as HostContext;
	return { ctx, tools, sections, routes, disposers };
}

function makeResponse() {
	const state = {
		status: 0,
		body: "",
		writeHead(status: number) {
			state.status = status;
			return state;
		},
		end(chunk?: unknown) {
			if (typeof chunk === "string") state.body += chunk;
		},
	};
	return state;
}

async function request(
	fixture: HostFixture,
	method: string,
): Promise<{
	status: number;
	snapshot: Record<string, unknown>;
	body: string;
}> {
	const route = fixture.routes.find(
		(candidate) => candidate.path === "/plugin-api/hover-glossary/lexicon",
	);
	assert.ok(route?.handler, "lexicon route is registered");
	const response = makeResponse();
	await route.handler(
		{ method, headers: {} } as IncomingMessage,
		response as unknown as ServerResponse,
	);
	return {
		status: response.status,
		body: response.body,
		snapshot:
			response.status === 200
				? (JSON.parse(response.body) as Record<string, unknown>)
				: {},
	};
}

const AGENT = { session: { id: "session-1" } };
const EXEC: ToolExec = { agent: AGENT };

async function tempProject(): Promise<{ home: string; project: string }> {
	const root = await mkdtemp(join(tmpdir(), "hover-glossary-"));
	const project = join(root, "project");
	await mkdir(project, { recursive: true });
	process.env.DSH_HOME = join(root, "dsh-home");
	return { home: join(root, "dsh-home"), project };
}

function tool(fixture: HostFixture, name: string): ToolDefinition {
	const definition = fixture.tools.get(name);
	assert.ok(definition, `${name} is registered`);
	return definition;
}

test("apply registers both tools and the prompt section", async () => {
	const { project } = await tempProject();
	const fixture = makeHost(project);
	apply(fixture.ctx);
	await stateFor(fixture.ctx).service.whenReady();

	assert.deepEqual([...fixture.tools.keys()].sort(), [
		"glossary_define",
		"glossary_lookup",
	]);
	const section = fixture.sections.find(
		(candidate) => candidate.name === "tool:hover-glossary",
	);
	assert.ok(section, "the tool guidance is a prompt section");
	assert.match(section.text, /glossary_define/);
	assert.ok(section.order > 2800);
	assert.equal(fixture.routes.length, 1);
});

test("glossary_define writes the project store, and a repeat writes nothing", async () => {
	const { project } = await tempProject();
	const fixture = makeHost(project);
	apply(fixture.ctx);
	const define = tool(fixture, "glossary_define");

	const first = (await define.execute(
		{
			term: "Руна",
			gloss: "внутренний формат обмена между слоями",
			kind: "термин",
			source: "README.md",
		},
		EXEC,
	)) as DefinedValue;
	assert.equal(first.status, "defined");
	assert.equal(first.scope, "project");
	assert.equal(first.revision, 2);
	assert.equal(first.entries.length, 1);
	assert.equal(first.entries[0]?.scope, "project");

	const storePath = join(project, ".dsh", "hover-glossary.json");
	const store = JSON.parse(await readFile(storePath, "utf8"));
	assert.equal(store.version, 1);
	assert.deepEqual(store.terms.Руна, [
		{
			text: "внутренний формат обмена между слоями",
			weight: 100,
			kind: "термин",
			source: "README.md",
			scope: "project",
		},
	]);

	const before = (await stat(storePath)).mtimeMs;
	const second = (await define.execute(
		{ term: "Руна", gloss: "внутренний формат обмена между слоями" },
		EXEC,
	)) as DefinedValue;
	assert.equal(second.status, "unchanged");
	assert.equal(
		second.revision,
		2,
		"an unchanged term does not bump the revision",
	);
	assert.equal(
		(await stat(storePath)).mtimeMs,
		before,
		"the store is not rewritten",
	);
});

test("glossary_define with scope global writes the user-wide store", async () => {
	const { home, project } = await tempProject();
	const fixture = makeHost(project);
	apply(fixture.ctx);
	const define = tool(fixture, "glossary_define");

	const result = (await define.execute(
		{
			term: "MTP",
			gloss: "multi-token prediction",
			scope: "global",
			weight: 300,
		},
		EXEC,
	)) as DefinedValue;
	assert.equal(result.status, "defined");
	assert.equal(result.scope, "global");

	const store = JSON.parse(
		await readFile(
			join(home, "data", "hover-glossary", "glossary.json"),
			"utf8",
		),
	);
	assert.equal(store.terms.MTP[0].text, "multi-token prediction");
	assert.equal(store.terms.MTP[0].weight, 300);
	assert.equal(store.terms.MTP[0].scope, "global");
});

test("glossary_lookup finds seeded and newly defined terms", async () => {
	const { project } = await tempProject();
	const fixture = makeHost(project);
	apply(fixture.ctx);
	const define = tool(fixture, "glossary_define");
	const lookup = tool(fixture, "glossary_lookup");

	const seeded = await lookup.execute({ query: "who" }, EXEC);
	assert.match(seeded.text, /ВОЗ/);
	assert.match(seeded.text, /кто/);

	await define.execute(
		{ term: "Руна", gloss: "внутренний формат обмена", scope: "project" },
		EXEC,
	);
	const defined = await lookup.execute({ query: "руна" }, EXEC);
	assert.match(defined.text, /внутренний формат обмена/);
	assert.match(defined.text, /\[project\]/);
});

test("the lexicon route serves the merged table, bumps the revision and rejects writes", async () => {
	const { project } = await tempProject();
	const fixture = makeHost(project);
	apply(fixture.ctx);

	const before = await request(fixture, "GET");
	assert.equal(before.status, 200);
	assert.equal(before.snapshot.revision, 1);
	const beforeTerms = before.snapshot.terms as Record<string, unknown[]>;
	assert.ok(beforeTerms.WHO, "the seed table is served");
	assert.deepEqual(before.snapshot.counts, {
		seed: Object.keys(SEED_TABLE).length,
		global: 0,
		project: 0,
	});

	await tool(fixture, "glossary_define").execute(
		{ term: "Руна", gloss: "внутренний формат обмена", scope: "project" },
		EXEC,
	);
	const after = await request(fixture, "GET");
	assert.equal(after.snapshot.revision, 2);
	const terms = after.snapshot.terms as Record<
		string,
		Array<{ scope?: string }>
	>;
	assert.equal(terms.Руна?.[0]?.scope, "project");
	assert.deepEqual(after.snapshot.counts, {
		seed: Object.keys(SEED_TABLE).length,
		global: 0,
		project: 1,
	});

	const rejected = await request(fixture, "POST");
	assert.equal(rejected.status, 405);
	assert.match(rejected.body, /method not allowed/);
});

test("a corrupt global store is set aside and the seed still loads", async () => {
	const { home, project } = await tempProject();
	const globalPath = join(home, "data", "hover-glossary", "glossary.json");
	await mkdir(join(home, "data", "hover-glossary"), { recursive: true });
	await writeFile(globalPath, "{not json", "utf8");

	const fixture = makeHost(project);
	apply(fixture.ctx);
	const served = await request(fixture, "GET");

	assert.equal(served.status, 200);
	assert.equal(served.snapshot.revision, 1);
	const terms = served.snapshot.terms as Record<string, unknown[]>;
	assert.ok(terms.WHO, "the seed table survives a broken store");
});
