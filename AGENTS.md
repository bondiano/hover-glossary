# hover-glossary Contributor Guide

Adaptive hover-tooltip glossary for DeepSeek Harness (`hover-glossary`, v2.0.0 Russian edition). See [README.md](README.md) and [../AGENTS.md](../AGENTS.md).

## Architecture & Layout

Follows the layered layout of `@local/dsh-role-team` with root compatibility facades (`index.ts`, `client.ts`, `config.ts`, `lexicon.ts`, `tools.ts`, `http.ts`, `state.ts`, `types.ts`):

- `src/domain/`: pure lexicon normalization and longest-match cursor lookup (`lexicon.ts`), limits and prompt guidance (`config.ts`), `effect` `Schema` store decoder (`store-schema.ts`), built-in dictionary (`seed.ts`), and XState v5 machines (`machines/lexicon-load.machine.ts`, `machines/term-intake.machine.ts`).
- `src/application/`: serialized mutation queue and merged snapshot service (`glossary-service.ts`, `state.ts`).
- `src/infrastructure/`: atomic temp+rename JSON store (`glossary-store.ts`, wrapped in `Effect.tryPromise`) and fail-closed route auth (`web-route-auth.ts`).
- `src/adapters/`: `glossary_define` / `glossary_lookup` tool definitions (`tools.ts`) and read-only HTTP route `/plugin-api/hover-glossary/lexicon` (`http.ts`).
- `src/presentation/`: Cordis `apply` entrypoint and system-prompt guidance registration (`index.ts`).
- `client.ts`: browser overlay, DOM chat-flow probe, and `window.__hoverGlossaryDiag__`.

## Invariants

- **Three store layers:** `src/domain/seed.ts` (built-in) -> `<DSH_HOME>/data/hover-glossary/glossary.json` (global) -> `<project>/.dsh/hover-glossary.json` (project, default `glossary_define` scope). Corrupt JSON is quarantined to `*.corrupt-<timestamp>` so the hover surface never breaks.
- **Workstation project glossary:** Maintained at [`../../../.dsh/hover-glossary.json`](../../../.dsh/hover-glossary.json); keep it valid against `decodeStore`, with Russian glosses, `scope: "project"`, and below 20,000 bytes.
- **Classic-script client parity:** `client.ts` has no top-level imports/exports (`moduleDetection: "legacy"`). Its embedded lookup must stay in parity with `src/domain/lexicon.ts` (tested in `test/client.test.ts`).
- **Committed `dist/`:** Commit compiled `dist/` after every TypeScript change (`prepare`/`prepack` are intentionally omitted so pnpm installs without build scripts).

## Verification

```sh
npm ci
npm run check     # oxfmt --check, oxlint --deny-warnings, tsc --noEmit, build + node --test dist/test/*.test.js
npm run format    # auto-format with oxfmt
npm run lint:fix  # auto-fix safe oxlint issues
```

If updating state machines, also run `cd ../machines && npm run check`. After edits inside this directory, update `repositories.json` snapshot metadata and run `node --test scripts/dsh-plugin-repositories.test.mjs` from the workstation root.
