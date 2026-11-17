/**
 * hover-glossary / model-facing tools.
 *
 * `glossary_define` is the only way a term enters the glossary from a
 * conversation; `glossary_lookup` is the duplicate check the guidance asks for
 * before writing. Both validate bounds in the domain limits, not in prose.
 */
import { LIMITS } from "../domain/config.js";
import { displayTerm } from "../domain/lexicon.js";
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringArg(args, field, options) {
    const required = options?.required === true;
    const max = options?.max ?? Number.MAX_SAFE_INTEGER;
    const value = isPlainObject(args) ? args[field] : undefined;
    if (value === undefined || value === null) {
        if (required)
            throw new Error(`\`${field}\` is required`);
        return undefined;
    }
    if (typeof value !== "string")
        throw new Error(`\`${field}\` must be a string`);
    const text = value.trim();
    if (text === "" && required)
        throw new Error(`\`${field}\` must be a non-empty string`);
    if (text.length > max)
        throw new Error(`\`${field}\` is longer than ${max} characters`);
    return text === "" ? undefined : text;
}
/** One text report per tool call. */
function renderText(_args, value) {
    return [{ type: "text", text: value.text }];
}
/** Register one tool with a caller context. */
export function registerTool(ctx, definition) {
    ctx.effect(() => ctx.tools.register(definition));
}
function scopeArg(args) {
    const value = isPlainObject(args) ? args.scope : undefined;
    if (value === undefined || value === null)
        return "project";
    if (value === "project" || value === "global")
        return value;
    throw new Error('`scope` must be "project" or "global"');
}
function weightArg(args) {
    const value = isPlainObject(args) ? args.weight : undefined;
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < LIMITS.weightMin ||
        value > LIMITS.weightMax)
        throw new Error(`\`weight\` must be a number between ${LIMITS.weightMin} and ${LIMITS.weightMax}`);
    return Math.trunc(value);
}
function entriesText(entries) {
    if (entries.length === 0)
        return "толкований нет";
    return entries
        .map((entry, index) => {
        const kind = entry.kind === undefined ? "" : ` (${entry.kind})`;
        const scope = entry.scope === undefined ? "" : ` [${entry.scope}]`;
        return `${index + 1}) ${entry.text}${kind}${scope}`;
    })
        .join("\n");
}
const DEFINE_OUTPUT = {
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
            text: { type: "string" },
            status: { type: "string" },
            term: { type: "string" },
            scope: { type: "string" },
            revision: { type: "number" },
            entries: { type: "array", items: {} },
        },
    },
    render: renderText,
    presentationMeta: (_args, value) => ({
        v: 1,
        tool: "glossary_define",
        status: value.status,
        term: value.term,
        scope: value.scope,
    }),
};
const LOOKUP_OUTPUT = {
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
            text: { type: "string" },
            term: { type: "string" },
            matches: { type: "array", items: {} },
        },
    },
    render: renderText,
    presentationMeta: (_args, value) => ({
        v: 1,
        tool: "glossary_lookup",
        term: value.term,
    }),
};
/** Build every model-facing tool of this plugin. */
export function buildTools(service) {
    return [
        {
            name: "glossary_define",
            description: 'Record one domain- or project-specific term in the glossary behind the chat hover tooltips. Use it while reading project docs, README files or domain material, for the terms a new reader of this project would not know. Do not record common words or generic programming terms. Call glossary_lookup first to avoid duplicates. Write the gloss in Russian. scope "project" (default) stores it in <project>/.dsh/hover-glossary.json, scope "global" in the user-wide glossary.',
            parameters: {
                type: "object",
                properties: {
                    term: {
                        type: "string",
                        description: `The term as it appears in the text, at most ${LIMITS.termChars} characters.`,
                    },
                    gloss: {
                        type: "string",
                        description: `The explanation in Russian, one self-contained sentence, at most ${LIMITS.glossChars} characters.`,
                    },
                    kind: {
                        type: "string",
                        description: `Optional label shown after the gloss, for example "аббр." or "термин" (at most ${LIMITS.kindChars} characters).`,
                    },
                    weight: {
                        type: "integer",
                        description: `Optional ranking inside the term, ${LIMITS.weightMin}-${LIMITS.weightMax}; the hover tooltip lists higher weights first. Defaults to ${LIMITS.defaultWeight}.`,
                    },
                    scope: {
                        type: "string",
                        enum: ["project", "global"],
                        default: "project",
                        description: 'Where the term is stored: "project" for this repository only, "global" for reusable domain vocabulary.',
                    },
                    source: {
                        type: "string",
                        description: `Optional path of the document that defines the term, at most ${LIMITS.sourceChars} characters.`,
                    },
                },
                required: ["term", "gloss"],
                additionalProperties: false,
            },
            output: DEFINE_OUTPUT,
            async execute(args, exec) {
                const term = stringArg(args, "term", {
                    required: true,
                    max: LIMITS.termChars,
                });
                const gloss = stringArg(args, "gloss", {
                    required: true,
                    max: LIMITS.glossChars,
                });
                const kind = stringArg(args, "kind", { max: LIMITS.kindChars });
                const source = stringArg(args, "source", { max: LIMITS.sourceChars });
                const scope = scopeArg(args);
                const weight = weightArg(args);
                const outcome = await service.defineTerm({
                    term,
                    scope,
                    entry: {
                        text: gloss,
                        weight: weight ?? LIMITS.defaultWeight,
                        ...(kind === undefined ? {} : { kind }),
                        ...(source === undefined ? {} : { source }),
                    },
                }, exec.agent);
                const revision = service.snapshot().revision;
                const head = outcome.status === "unchanged"
                    ? `«${displayTerm(term)}» уже содержит это толкование (${scope}); файл не изменён.`
                    : outcome.status === "defined"
                        ? `«${displayTerm(term)}» записан в ${scope} (revision ${revision}).`
                        : `не удалось записать «${displayTerm(term)}»: ${outcome.error ?? "неизвестная ошибка"}`;
                return {
                    text: `${head}\n${entriesText(outcome.entries)}`,
                    status: outcome.status,
                    term: outcome.term,
                    scope: outcome.scope,
                    revision,
                    entries: outcome.entries,
                    ...(outcome.error === undefined ? {} : { error: outcome.error }),
                };
            },
        },
        {
            name: "glossary_lookup",
            description: "Look a term up in the glossary behind the chat hover tooltips: an exact normalized match first, then terms containing the query. Call it before glossary_define to avoid writing a gloss that already exists.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "The term or its fragment to look up.",
                    },
                },
                required: ["query"],
                additionalProperties: false,
            },
            output: LOOKUP_OUTPUT,
            async execute(args) {
                const query = stringArg(args, "query", {
                    required: true,
                    max: LIMITS.termChars,
                });
                const result = await service.lookup(query);
                if (result.exact)
                    return {
                        text: `«${result.exact.term}» — ${result.exact.entries.length} толкований:\n${entriesText(result.exact.entries)}`,
                        term: result.exact.term,
                        matches: result.matches,
                    };
                if (result.matches.length > 0)
                    return {
                        text: `Точного совпадения нет. Похожие термины (${result.matches.length}):\n${result.matches.map((match) => `${match.term} — ${match.count} толкований`).join("\n")}`,
                        term: "",
                        matches: result.matches,
                    };
                return {
                    text: `Совпадений нет: «${query}».`,
                    term: "",
                    matches: [],
                };
            },
        },
    ];
}
