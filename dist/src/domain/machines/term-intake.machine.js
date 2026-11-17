/**
 * hover-glossary / term intake machine.
 *
 * One `glossary_define` call is: append the gloss to a copy of the store,
 * write it atomically, then republish the merged table. A gloss that already
 * exists ends in `unchanged` without touching the disk.
 */
import { assign, fromPromise, setup } from "xstate";
import { messageOf } from "../config.js";
import { displayTerm } from "../lexicon.js";
import { actorError } from "./actor-events.js";
export const termIntakeMachine = setup({
    types: {
        input: {},
        context: {},
        events: {},
    },
    actors: {
        persistStore: fromPromise(async () => {
            throw new Error("persistStore actor must be provided");
        }),
        refreshSnapshot: fromPromise(async () => {
            throw new Error("refreshSnapshot actor must be provided");
        }),
    },
    guards: {
        glossAlreadyPresent: ({ context }) => (context.target.terms[context.key] ?? []).some((existing) => displayTerm(existing.text) === context.entry.text),
    },
    actions: {
        appendEntry: assign({
            file: ({ context }) => ({
                version: 1,
                terms: {
                    ...context.target.terms,
                    [context.key]: [
                        ...(context.target.terms[context.key] ?? []),
                        { ...context.entry, scope: context.scope },
                    ],
                },
            }),
        }),
        recordError: assign({
            error: ({ event }) => messageOf(actorError(event)),
        }),
    },
}).createMachine({
    id: "termIntake",
    initial: "appending",
    context: ({ input }) => ({
        target: input.target,
        scope: input.scope,
        path: input.path,
        term: displayTerm(input.term),
        key: displayTerm(input.term),
        entry: { ...input.entry, text: displayTerm(input.entry.text) },
    }),
    states: {
        appending: {
            always: [
                { guard: "glossAlreadyPresent", target: "unchanged" },
                { target: "persisting", actions: "appendEntry" },
            ],
        },
        persisting: {
            invoke: {
                src: "persistStore",
                input: ({ context }) => ({
                    path: context.path,
                    file: context.file,
                }),
                onDone: { target: "refreshing" },
                onError: { target: "failed", actions: "recordError" },
            },
        },
        refreshing: {
            invoke: {
                src: "refreshSnapshot",
                input: ({ context }) => ({
                    scope: context.scope,
                    file: context.file,
                }),
                onDone: { target: "defined" },
                onError: { target: "failed", actions: "recordError" },
            },
        },
        defined: { type: "final" },
        unchanged: { type: "final" },
        failed: { type: "final" },
    },
});
