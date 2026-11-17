import assert from "node:assert/strict";
import test from "node:test";

import {
	createLexicon,
	Lexicon,
	mergeTables,
	normalize,
	tokenAt,
} from "../src/domain/lexicon.js";
import { SEED_TABLE } from "../src/domain/seed.js";

const lexicon = createLexicon(SEED_TABLE);

test("one term carries 1..N glosses, numbered and stable", () => {
	const entries = lexicon.lookup("WHO");
	assert.equal(entries.length, 2, "WHO has two glosses");
	assert.deepEqual(
		entries.map((entry) => entry.text),
		["ВОЗ", "кто"],
	);
	assert.deepEqual(
		entries.map((entry) => entry.index),
		[1, 2],
		"the tooltip draws «1) … 2) …»",
	);
	assert.equal(entries[0]?.kind, "аббр.");
	assert.equal(entries[1]?.kind, "местоимение");

	assert.equal(lexicon.lookup("API").length, 3);

	// Identical gloss text is never silently collapsed.
	const duplicate = new Lexicon().add("X", ["одно и то же", "одно и то же"]);
	assert.equal(duplicate.lookup("X").length, 2);
});

test("cursor lookup prefers the longest match and respects word boundaries", () => {
	const phrase = lexicon.lookupAt(
		"Всемирная организация здравоохранения помогает",
		3,
	);
	assert.equal(phrase.term, "Всемирная организация здравоохранения");
	assert.equal(
		phrase.entries[0]?.text,
		"Всемирная организация здравоохранения, сокращённо ВОЗ",
	);

	const short = lexicon.lookupAt("ВОЗ в Женеве", 1);
	assert.equal(short.term, "ВОЗ");
	assert.equal(
		short.entries[0]?.text,
		"Всемирная организация здравоохранения (ВОЗ)",
	);

	const longWord = lexicon.lookupAt("токенизатор собран", 4);
	assert.equal(longWord.term, "токенизатор");
	assert.match(longWord.entries[0]?.text ?? "", /tokenizer/);

	assert.equal(
		lexicon.lookupAt("псевдотокен", 7).entries.length,
		0,
		"a suffix of a longer word is not a match",
	);

	const united = "joined United Nations in 1945";
	const atStart = lexicon.lookupAt(united, 9);
	assert.equal(atStart.term, "United Nations");
	assert.equal(atStart.start, 7);
	assert.equal(atStart.end, 21);
	assert.equal(
		lexicon.lookupAt(united, 15).entries.length,
		0,
		"the second word of a phrase does not match alone",
	);

	const hidden = "это скрытое состояние модели";
	assert.equal(lexicon.lookupAt(hidden, 6).term, "скрытое состояние");
	assert.equal(lexicon.lookupAt(hidden, 14).entries.length, 0);
});

test("case, punctuation, full-width characters and spaces fold into one key", () => {
	assert.equal(normalize("  ВОЗ,"), "воз");
	assert.equal(normalize("ＷＨＯ"), "who");
	assert.equal(normalize("United   Nations!"), "united nations");
	assert.equal(normalize("ЁЖ"), "ёж");

	for (const spelling of [
		"who",
		"Who",
		"WHO",
		"ＷＨＯ",
		"(WHO)",
		"«WHO»",
		"WHO.",
	]) {
		const entries = lexicon.lookup(spelling);
		assert.equal(entries.length, 2, `${spelling} finds both WHO glosses`);
		assert.equal(entries[0]?.text, "ВОЗ");
	}

	assert.equal(lexicon.lookup("unitednations").length, 0);
	assert.equal(lexicon.lookup("").length, 0);
	assert.equal(lexicon.lookup(null).length, 0, "non-string input stays empty");
});

test("tokenAt and lookupAt agree on Russian and mixed text", () => {
	const text = "используй API и DSH тут";
	const api = text.indexOf("API");
	const dsh = text.indexOf("DSH");

	assert.deepEqual(tokenAt(text, api + 1), {
		term: "API",
		start: api,
		end: api + 3,
	});
	assert.equal(
		lexicon.lookupAt(text, api + 1).entries[0]?.text,
		"интерфейс прикладного программирования",
	);

	assert.equal(text[api + 3], " ");
	assert.equal(tokenAt(text, api + 3), null);
	assert.equal(lexicon.lookupAt(text, api + 3).term, "API");

	assert.equal(lexicon.lookupAt(text, 3).term, "используй");

	assert.deepEqual(tokenAt(text, text.indexOf(" и ") + 1), {
		term: "и",
		start: text.indexOf(" и ") + 1,
		end: text.indexOf(" и ") + 2,
	});
	assert.deepEqual(tokenAt(text, dsh + 1), {
		term: "DSH",
		start: dsh,
		end: dsh + 3,
	});
	assert.match(
		lexicon.lookupAt(text, dsh + 1).entries[0]?.text ?? "",
		/DeepSeek Harness/,
	);

	assert.deepEqual(tokenAt(text, 999), {
		term: "тут",
		start: text.indexOf("тут"),
		end: text.length,
	});
	assert.deepEqual(tokenAt(text, -5), { term: "используй", start: 0, end: 9 });
	assert.equal(tokenAt("", 0), null);
	assert.equal(tokenAt(text, Number.NaN), null);
});

test("every seeded term resolves in real text and the index self-checks", () => {
	const report = lexicon.validate();
	assert.equal(report.ok, true, report.problems.join("; "));

	assert.equal(lexicon.size, Object.keys(SEED_TABLE).length);
	assert.equal(
		lexicon.itemCount,
		Object.values(SEED_TABLE).reduce((sum, list) => sum + list.length, 0),
	);

	for (const [term, items] of Object.entries(SEED_TABLE)) {
		const entries = lexicon.lookup(term);
		assert.equal(
			entries.length,
			items.length,
			`«${term}» keeps its gloss count`,
		);
		assert.ok(entries.every((entry) => entry.text.length > 0));
		assert.deepEqual(
			entries.map((entry) => entry.index),
			entries.map((_, index) => index + 1),
		);
	}

	const full = [
		"Я спросил: объясни WHO и United Nations в двух словах",
		"Ответ: WHO — это ВОЗ, она же Всемирная организация здравоохранения; в DSH плагины расширяет Cordis.",
		"Ещё: чем API отличается от LLM и при чём тут DeepSeek",
	].join("\n");

	const expected: Array<[string, number]> = [
		["WHO", 2],
		["ВОЗ", 2],
		["Всемирная организация здравоохранения", 1],
		["United Nations", 2],
		["DSH", 2],
		["Cordis", 2],
		["API", 3],
		["LLM", 2],
		["DeepSeek", 1],
	];
	let probes = 0;
	for (const [term, count] of expected) {
		const start = full.toLowerCase().indexOf(term.toLowerCase());
		assert.ok(start >= 0, `текст не содержит «${term}»`);
		const firstWord = term.split(" ")[0] ?? term;
		for (let cursor = start; cursor < start + firstWord.length; cursor += 1) {
			const found = lexicon.lookupAt(full, cursor);
			probes += 1;
			assert.ok(
				found.entries.length >= 1,
				`курсор ${cursor} находит толкования`,
			);
			assert.ok(
				found.start <= cursor && cursor < found.end,
				`курсор ${cursor}: ${found.start}-${found.end} не накрывает курсор`,
			);
			assert.equal(full.slice(found.start, found.end), found.term);
			if (!term.includes(" ")) {
				assert.equal(found.term, term);
				assert.equal(found.entries.length, count);
			}
		}
	}
	assert.ok(probes > 30);
	assert.deepEqual(lexicon.lookup("WHO"), lexicon.lookup("WHO"));
});

test("mergeTables concatenates seed, global and project in that order and caps at 8", () => {
	const seed = { T: [{ text: "seed", weight: 100 }] };
	const global = {
		T: [{ text: "global", weight: 100, scope: "global" as const }],
	};
	const project = {
		T: [
			{ text: "project", weight: 100, scope: "project" as const },
			{ text: "hot", weight: 500, scope: "project" as const },
		],
	};
	const merged = mergeTables(seed, global, project);
	const entries = merged.T ?? [];
	assert.deepEqual(
		entries.map((entry) => entry.text),
		["hot", "seed", "global", "project"],
		"weight desc, equal weights keep seed -> global -> project order",
	);
	assert.deepEqual(
		entries.map((entry) => entry.scope),
		["project", undefined, "global", "project"],
	);

	const crowded = mergeTables(
		{},
		{},
		{
			T: Array.from({ length: 12 }, (_, index) => ({
				text: `g${index}`,
			})),
		},
	);
	assert.equal(crowded.T?.length, 8, "the cap keeps 8 glosses per term");
});
