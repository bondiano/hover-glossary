"use strict";
/**
 * hover-glossary / browser half.
 *
 * Classic script on purpose: the DSH module loader evaluates it without a
 * module system, so this file has no top-level import or export and resolves
 * only `react` through `factory(require)`. Everything the tip needs is inline:
 * the index comes from the Host route, and the lookup rules are a small copy of
 * the domain lexicon (relative imports are impossible here).
 *
 * Contract of the loader: `window.__ModuleLoader__.load({ id, factory })`;
 * the returned object declares `inject` and `apply`.
 */
window.__ModuleLoader__.load({
    id: "hover-glossary",
    factory(require) {
        const React = require("react");
        /** Same-origin route served by the Host half. */
        const ROUTE = "/plugin-api/hover-glossary/lexicon";
        /** Matches `LIMITS.pollMs` in the Host half. */
        const POLL_MS = 30_000;
        /* ── Lookup: the part of the domain lexicon the tip needs ─────────── */
        const APOSTROPHES = /[\u2018\u2019\u02bc\u02b9`]/g;
        const PUNCT_EDGE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
        const CJK_SPACE = /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;
        const WORD_CHAR = /[\p{L}\p{N}\p{M}\u2019\u02bc'\u05f3\u30fb\u30fc\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/u;
        const BOUNDARY = /[\p{L}\p{N}_]/u;
        const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
        function normalize(input) {
            if (typeof input !== "string")
                return "";
            let text = input.normalize("NFKC");
            text = text.replace(APOSTROPHES, "'");
            text = text.replace(/\s+/g, " ");
            text = text.replace(CJK_SPACE, "");
            text = text.replace(PUNCT_EDGE, "");
            return text.toLowerCase();
        }
        function isWordChar(ch) {
            if (typeof ch !== "string" || ch.length === 0)
                return false;
            return WORD_CHAR.test(ch);
        }
        function tokenAt(text, cursor) {
            if (typeof text !== "string" || text.length === 0)
                return null;
            if (!Number.isFinite(cursor))
                return null;
            let index = Math.max(0, Math.min(text.length, Math.trunc(cursor)));
            if (index >= text.length) {
                if (index > 0 && isWordChar(text[index - 1]))
                    index -= 1;
                else
                    return null;
            }
            else if (!isWordChar(text[index])) {
                return null;
            }
            let start = index;
            let end = index + 1;
            while (start > 0 && isWordChar(text[start - 1]))
                start -= 1;
            while (end < text.length && isWordChar(text[end]))
                end += 1;
            return { term: text.slice(start, end), start, end };
        }
        function blocksWordBoundary(text, start, end) {
            const blocks = (ch) => typeof ch === "string" && BOUNDARY.test(ch) && !CJK.test(ch);
            if (blocks(text[start]) && start > 0 && blocks(text[start - 1]))
                return true;
            if (blocks(text[end - 1]) && end < text.length && blocks(text[end]))
                return true;
            return false;
        }
        /** Index a merged table; longest-key match wins, word boundaries hold. */
        function createIndex(terms) {
            const entries = new Map();
            let maxKeyLength = 0;
            let itemCount = 0;
            for (const term of Object.keys(terms)) {
                const key = normalize(term);
                const list = terms[term] ?? [];
                if (key.length === 0 || list.length === 0)
                    continue;
                entries.set(key, list);
                if (key.length > maxKeyLength)
                    maxKeyLength = key.length;
                itemCount += list.length;
            }
            function lookupAt(text, cursor) {
                const span = maxKeyLength > 0 ? maxKeyLength : 16;
                let hit = tokenAt(text, cursor);
                if (!hit) {
                    const position = Math.max(0, Math.min(text.length, Math.trunc(cursor || 0)));
                    const previous = position > 0 ? text[position - 1] : "";
                    const next = text[position];
                    const staysLeft = (previous === " " || previous === "\t" || !isWordChar(next)) &&
                        isWordChar(previous);
                    if (staysLeft) {
                        const left = tokenAt(text, position - 1);
                        if (left)
                            hit = left;
                    }
                    if (!hit) {
                        let scan = position;
                        while (scan < text.length && !isWordChar(text[scan]))
                            scan += 1;
                        if (scan < text.length)
                            return lookupAt(text, scan);
                    }
                }
                const cursorPosition = Math.max(0, Math.min(text.length, Math.trunc(cursor || 0)));
                const tokenStart = hit ? Math.min(hit.start, cursorPosition) : 0;
                const tokenEnd = hit ? hit.end : 0;
                const starts = [];
                if (hit) {
                    for (let start = tokenStart; start <= cursorPosition; start += 1)
                        starts.push(start);
                }
                if (starts.length === 0)
                    starts.push(cursorPosition);
                const candidates = [];
                for (const start of starts) {
                    const stop = Math.min(text.length, Math.max(hit && start === tokenStart ? tokenEnd : 0, start + Math.max(1, span)));
                    let sawWordChar = false;
                    for (let end = start + 1; end <= stop; end += 1) {
                        const ch = text[end - 1];
                        if (isWordChar(ch)) {
                            sawWordChar = true;
                            if (end > cursorPosition)
                                candidates.push({
                                    key: normalize(text.slice(start, end)),
                                    start,
                                    end,
                                });
                            continue;
                        }
                        if (sawWordChar &&
                            (ch === " " || ch === "\t") &&
                            end < text.length &&
                            isWordChar(text[end]))
                            continue;
                        break;
                    }
                }
                candidates.sort((left, right) => right.end - right.start - (left.end - left.start) ||
                    left.start - right.start);
                for (const candidate of candidates) {
                    const list = entries.get(candidate.key);
                    if (list && list.length > 0) {
                        if (blocksWordBoundary(text, candidate.start, candidate.end))
                            continue;
                        return {
                            term: text.slice(candidate.start, candidate.end),
                            key: candidate.key,
                            start: candidate.start,
                            end: candidate.end,
                            entries: list,
                        };
                    }
                }
                if (hit) {
                    const key = normalize(hit.term);
                    const list = entries.get(key);
                    if (list && list.length > 0)
                        return {
                            term: hit.term,
                            key,
                            start: hit.start,
                            end: hit.end,
                            entries: list,
                        };
                }
                return {
                    term: hit ? hit.term : "",
                    key: "",
                    start: cursorPosition,
                    end: cursorPosition,
                    entries: [],
                };
            }
            return { size: entries.size, itemCount, maxKeyLength, lookupAt };
        }
        /* ── Rendering ───────────────────────────────────────────────────── */
        /** Russian plural of the gloss counter. */
        function countLabel(count) {
            const mod10 = count % 10;
            const mod100 = count % 100;
            if (mod10 === 1 && mod100 !== 11)
                return `${count} значение`;
            if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
                return `${count} значения`;
            return `${count} значений`;
        }
        const CSS = [
            ".hg-tip{position:fixed;z-index:2147483000;max-width:min(380px,calc(100vw - 24px));pointer-events:none;box-sizing:border-box;",
            "padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);",
            "background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);",
            "box-shadow:0 6px 24px rgba(0,0,0,.28);font-size:12px;line-height:1.6;}",
            ".hg-tip-head{display:flex;align-items:baseline;gap:6px;margin-bottom:2px;}",
            ".hg-tip-word{font-weight:600;}",
            ".hg-tip-tag{color:var(--dsw-alias-label-secondary);font-size:11px;}",
            ".hg-tip ol{margin:0;padding-left:18px;}",
            ".hg-tip li{margin:1px 0;}",
            ".hg-tip .hg-tip-kind{color:var(--dsw-alias-label-secondary);font-size:11px;margin-left:6px;}",
        ].join("");
        const hoverStore = {
            state: {
                visible: false,
                term: "",
                entries: [],
                x: 0,
                y: 0,
            },
            listeners: new Set(),
            publish(next) {
                this.state = next;
                for (const listener of this.listeners)
                    listener(next);
            },
        };
        const BROWSER = (() => {
            const doc = typeof document === "undefined" ? null : document;
            if (!doc || typeof doc.addEventListener !== "function")
                return null;
            return { root: window, doc };
        })();
        /** Inside interactive elements and foreign tooltips we stay silent. */
        const INTERACTIVE = {
            button: 1,
            a: 1,
            input: 1,
            textarea: 1,
            select: 1,
            option: 1,
            summary: 1,
        };
        /** The character at a document point, and the text it came from. */
        function charAtPoint(x, y) {
            if (!BROWSER)
                return null;
            const doc = BROWSER.doc;
            const element = doc.elementFromPoint(x, y);
            if (!element)
                return null;
            let node = null;
            let offset = -1;
            if (typeof doc.caretRangeFromPoint === "function") {
                const range = doc.caretRangeFromPoint(x, y);
                if (range &&
                    range.startContainer &&
                    range.startContainer.nodeType === 3) {
                    node = range.startContainer;
                    offset = range.startOffset;
                }
            }
            if (!node && typeof doc.caretPositionFromPoint === "function") {
                const position = doc.caretPositionFromPoint(x, y);
                if (position &&
                    position.offsetNode &&
                    position.offsetNode.nodeType === 3) {
                    node = position.offsetNode;
                    offset = position.offset;
                }
            }
            if (!node || offset < 0)
                return null;
            const dataNode = node;
            const data = typeof dataNode.data === "string" ? dataNode.data : "";
            if (data.length === 0)
                return null;
            // The caret may sit right after the visible glyph, so try both neighbours
            // and require the pointer to be inside the glyph itself: the caret API
            // snaps to the nearest text even over empty space.
            const candidates = [];
            if (offset > 0 && isWordChar(data[offset - 1]))
                candidates.push(offset - 1);
            if (offset < data.length && isWordChar(data[offset]))
                candidates.push(offset);
            for (const at of candidates) {
                const glyph = doc.createRange();
                glyph.setStart(dataNode, at);
                glyph.setEnd(dataNode, at + 1);
                if (Array.from(glyph.getClientRects()).some((rect) => x >= rect.left &&
                    x <= rect.right &&
                    y >= rect.top &&
                    y <= rect.bottom))
                    return { text: data, at, element: node.parentElement ?? element };
            }
            return null;
        }
        /** Walk up from the found element and decide whether a tip belongs here. */
        function classify(element) {
            if (!element)
                return { ok: false, reason: "no-element", chain: [] };
            const chain = [];
            let current = element;
            let inConversation = false;
            while (current &&
                current !== BROWSER?.doc.body &&
                current !== BROWSER?.doc.documentElement) {
                const tag = typeof current.tagName === "string"
                    ? current.tagName.toLowerCase()
                    : "?";
                let classes = "";
                try {
                    classes =
                        typeof current.className === "string" ? current.className : "";
                }
                catch {
                    classes = "";
                }
                if (chain.length < 6)
                    chain.push(tag +
                        (classes
                            ? `.${classes.split(" ").filter(Boolean).slice(0, 2).join(".")}`
                            : ""));
                if (INTERACTIVE[tag])
                    return { ok: false, reason: `inside-${tag}`, chain };
                if (current.getAttribute("contenteditable") === "true")
                    return { ok: false, reason: "editable", chain };
                const kind = current.getAttribute("data-chat-flow-kind");
                if (kind === "user" || kind === "assistant-step" || kind === "steering")
                    inConversation = true;
                current = current.parentElement;
            }
            return {
                ok: inConversation,
                reason: inConversation ? "conversation" : "outside-conversation",
                chain,
            };
        }
        /** Diagnostics on startup, merged with the live revision by `load`. */
        function selfCheck(trace) {
            trace.hasElementFromPoint = !!(BROWSER && BROWSER.doc.elementFromPoint);
            trace.hasCaretRangeFromPoint = !!(BROWSER && typeof BROWSER.doc.caretRangeFromPoint === "function");
            trace.hasCaretPositionFromPoint = !!(BROWSER && typeof BROWSER.doc.caretPositionFromPoint === "function");
            if (BROWSER) {
                const width = BROWSER.root.innerWidth || 0;
                const height = BROWSER.root.innerHeight || 0;
                const probe = charAtPoint(Math.round(width * 0.5), Math.round(height * 0.35));
                trace.probe = probe
                    ? { ok: true, text: probe.text.slice(0, 24), at: probe.at }
                    : { ok: false };
                if (probe) {
                    const verdict = classify(probe.element);
                    trace.classify = {
                        ok: verdict.ok,
                        reason: verdict.reason,
                        chain: verdict.chain.join(" < "),
                    };
                    const token = tokenAt(probe.text, probe.at);
                    trace.token = token ? token.term : null;
                }
            }
            window.__hoverGlossaryDiag__ = trace;
            console.log(`[hover-glossary] самопроверка ${JSON.stringify(trace)}`);
        }
        function GlossaryTip() {
            const [state, setState] = React.useState(hoverStore.state);
            React.useEffect(() => {
                const listener = (next) => setState(next);
                hoverStore.listeners.add(listener);
                return () => {
                    hoverStore.listeners.delete(listener);
                };
            }, []);
            if (!state.visible)
                return null;
            const width = BROWSER ? BROWSER.root.innerWidth : 1200;
            const height = BROWSER ? BROWSER.root.innerHeight : 800;
            const below = state.y < height / 2;
            const style = {
                left: `${Math.max(12, Math.min(state.x + 14, width - 392))}px`,
                top: below ? `${state.y + 18}px` : undefined,
                bottom: below ? undefined : `${height - state.y + 12}px`,
                maxHeight: `${Math.max(40, below ? height - state.y - 30 : state.y - 24)}px`,
                overflow: "auto",
            };
            const head = React.createElement("div", { className: "hg-tip-head" }, React.createElement("span", { className: "hg-tip-word" }, state.term), React.createElement("span", { className: "hg-tip-tag" }, countLabel(state.entries.length)));
            const body = React.createElement("ol", null, state.entries.map((entry, index) => React.createElement("li", { key: index }, entry.text, entry.kind
                ? React.createElement("span", { className: "hg-tip-kind" }, entry.kind)
                : null)));
            return React.createElement("div", { className: "hg-tip", role: "tooltip", style }, head, body);
        }
        function apply(ctx) {
            // The module graph lives in package.json; service dependencies are the
            // exported `inject` below.
            const slots = ctx.slots;
            slots.inject("shell.overlay", () => slots.register({ name: "shell.overlay", id: "hover-glossary-tip", order: 200 }, () => React.createElement(GlossaryTip)));
            if (!BROWSER) {
                console.error("в окружении нет document: словарю при наведении некого слушать");
                return;
            }
            let index = createIndex({});
            let revision = -1;
            let loading = false;
            let shown = "";
            let last = 0;
            /** Pull the merged table; a new revision rebuilds the index. */
            async function load() {
                if (loading)
                    return;
                loading = true;
                try {
                    const response = await fetch(ROUTE, {
                        credentials: "same-origin",
                        headers: { accept: "application/json" },
                    });
                    if (!response.ok)
                        return;
                    const snapshot = (await response.json());
                    if (!snapshot || snapshot.ok !== true)
                        return;
                    const next = typeof snapshot.revision === "number" ? snapshot.revision : -1;
                    if (next === revision)
                        return;
                    index = createIndex(snapshot.terms && typeof snapshot.terms === "object"
                        ? snapshot.terms
                        : {});
                    revision = next;
                    // The term cached by the hover loop now belongs to the old table.
                    shown = "";
                    window.__hoverGlossaryDiag__ = {
                        ...window.__hoverGlossaryDiag__,
                        revision,
                        terms: index.size,
                        entries: index.itemCount,
                    };
                }
                catch (error) {
                    console.debug("[hover-glossary] словарь недоступен", error);
                }
                finally {
                    loading = false;
                }
            }
            selfCheck({ revision: -1 });
            const style = document.createElement("style");
            style.dataset.hoverGlossary = "";
            style.textContent = CSS;
            document.head.append(style);
            const hide = () => {
                shown = "";
                if (hoverStore.state.visible)
                    hoverStore.publish({
                        visible: false,
                        term: "",
                        entries: [],
                        x: 0,
                        y: 0,
                    });
            };
            // Plain closure throttle: no timers to leak on dispose.
            const onMove = (event) => {
                const now = Date.now();
                if (now - last < 50)
                    return;
                last = now;
                const x = event.clientX;
                const y = event.clientY;
                const hit = charAtPoint(x, y);
                if (!hit) {
                    hide();
                    return;
                }
                if (!classify(hit.element).ok) {
                    hide();
                    return;
                }
                const match = index.lookupAt(hit.text, hit.at);
                if (match.entries.length === 0) {
                    hide();
                    return;
                }
                if (match.key === shown) {
                    hoverStore.publish({ ...hoverStore.state, visible: true, x, y });
                    return;
                }
                shown = match.key;
                hoverStore.publish({
                    visible: true,
                    term: match.term,
                    entries: match.entries,
                    x,
                    y,
                });
            };
            const onLeave = () => hide();
            const onVisible = () => {
                if (document.visibilityState === "visible")
                    void load();
            };
            BROWSER.doc.addEventListener("mousemove", onMove, { passive: true });
            BROWSER.doc.addEventListener("mouseleave", onLeave, { passive: true });
            BROWSER.doc.addEventListener("scroll", onLeave, true);
            BROWSER.doc.addEventListener("visibilitychange", onVisible);
            BROWSER.root.addEventListener("focus", onVisible);
            const poll = setInterval(onVisible, POLL_MS);
            void load();
            ctx.effect(() => () => {
                clearInterval(poll);
                BROWSER.doc.removeEventListener("mousemove", onMove);
                BROWSER.doc.removeEventListener("mouseleave", onLeave);
                BROWSER.doc.removeEventListener("scroll", onLeave, true);
                BROWSER.doc.removeEventListener("visibilitychange", onVisible);
                BROWSER.root.removeEventListener("focus", onVisible);
                style.remove();
                delete window.__hoverGlossaryDiag__;
                hoverStore.publish({
                    visible: false,
                    term: "",
                    entries: [],
                    x: 0,
                    y: 0,
                });
            });
        }
        return {
            apply,
            // Cordis permission to reach services: a different list from the
            // module-graph dependencies in package.json.
            inject: ["slots"],
        };
    },
});
