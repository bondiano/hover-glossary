/**
 * hover-glossary / domain types.
 *
 * Only the Host contracts this plugin consumes: the tool registry, the system
 * prompt section registry, the working-directory seam and the web-server seam.
 * Nothing here touches Node or Cordis at runtime.
 */

import type {
	IncomingHttpHeaders,
	IncomingMessage,
	ServerResponse,
} from "node:http";

export type Disposer = () => void;

/** Where one glossary entry is stored. */
export type GlossaryScope = "global" | "project";

/** One gloss of a term, as written to a store or a seed table. */
export interface GlossaryEntryInput {
	text: string;
	kind?: string;
	weight?: number;
	tags?: string[];
	scope?: GlossaryScope;
	source?: string;
}

/** A gloss inside a built lexicon; `index` is the 1-based display number. */
export interface GlossaryEntry extends GlossaryEntryInput {
	index?: number;
}

/** One on-disk store. */
export interface GlossaryFile {
	version: 1;
	terms: Record<string, GlossaryEntryInput[]>;
}

/** What the browser polls: the merged table plus per-layer counts. */
export interface LexiconSnapshot {
	ok: true;
	revision: number;
	terms: Record<string, GlossaryEntryInput[]>;
	counts: { seed: number; global: number; project: number };
}

export interface Agent {
	session?: { id?: string };
}

export interface ToolExec {
	agent?: Agent;
	signal?: AbortSignal;
	callId?: string;
}

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ToolValue {
	text: string;
	[key: string]: unknown;
}

export interface ToolOutput {
	schema: object;
	render(args: unknown, value: ToolValue): TextBlock[];
	presentationMeta(args: unknown, value: ToolValue): object;
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: object;
	output: ToolOutput;
	execute(args: unknown, exec: ToolExec): Promise<ToolValue>;
}

export interface WebConnection {
	allowsRemoteAuthorities?: boolean;
	requestRejection?(request: {
		headers: IncomingHttpHeaders;
	}): number | undefined;
}

export interface WebRoute {
	kind: "exact" | "prefix";
	path: string;
	handler?: (
		request: IncomingMessage,
		response: ServerResponse,
		...args: unknown[]
	) => unknown;
	resource?: (request: Request, ...args: unknown[]) => Response;
}

export interface WebServer {
	host?: string;
	getOrigin(): string;
	register(route: WebRoute): Disposer;
}

export interface HostServices {
	workingDirectory: {
		get(session?: Agent["session"]): string | undefined;
	};
	connection: WebConnection;
	webServer: WebServer;
}

export interface HostContext {
	get<K extends keyof HostServices>(name: K): HostServices[K] | undefined;
	fiber?: { entry?: { options?: { config?: unknown } } & object };
	logger?: { info?(message: string): void; warn?(message: string): void };
	effect(callback: () => unknown, label?: string): unknown;
	tools: { register(definition: ToolDefinition): Disposer };
	systemPrompt: {
		getSectionOrder?(section: string): number | undefined;
		section(definition: {
			name: string;
			order: number;
			text: string;
		}): Disposer;
	};
	inject(services: string[], callback: (context: HostContext) => void): void;
}
