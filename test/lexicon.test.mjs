/**
 * hover-glossary / test/lexicon.test.mjs
 *
 * Пять тестов покрывают: отображение 1 -> N, приоритет длинного слова,
 * нормализацию (регистр/пунктуация/полноширинные символы/пробелы),
 * позиционирование курсора в русском и смешанном тексте и запасной путь
 * для не входящих в словарь слов.
 *
 * Запуск: node test/run.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Lexicon, createLexicon, normalize, tokenAt } from '../src/lexicon.mjs';
import { SEED_TABLE } from '../src/seed-data.mjs';

const lexicon = createLexicon(SEED_TABLE);

/* ------------------------------------------------------------------ *
 * Тест 1: 1 -> N толкований, порядок и нумерация сохраняются
 * ------------------------------------------------------------------ */
test('тест1: одно слово -> несколько толкований (WHO => 1) ВОЗ 2) кто)', () => {
  const entries = lexicon.lookup('WHO');

  assert.equal(entries.length, 2, 'у WHO должно быть два толкования');
  assert.deepEqual(
    entries.map((e) => e.text),
    ['ВОЗ', 'кто'],
  );
  assert.deepEqual(
    entries.map((e) => e.index),
    [1, 2],
    'толкования нумеруются подряд — интерфейс рисует «1) ... 2) ...»',
  );
  assert.equal(entries[0].kind, 'аббр.');
  assert.equal(entries[1].kind, 'местоимение');

  // 1 -> 3 тоже работает, а не только два толкования
  assert.equal(lexicon.lookup('API').length, 3);

  // N толкований не сливаются и не дедуплицируются
  const dup = new Lexicon().add('X', ['одно и то же', 'одно и то же']);
  assert.equal(dup.lookup('X').length, 2, 'одинаковый текст не должен молча схлопываться');
});

/* ------------------------------------------------------------------ *
 * Тест 2: сначала самое длинное совпадение, затем границы слова
 * ------------------------------------------------------------------ */
test('тест2: поиск по курсору предпочитает длинное совпадение и соблюдает границы слова', () => {
  // Словосочетание целиком: курсор в первом слове
  const phrase = lexicon.lookupAt('Всемирная организация здравоохранения помогает', 3);
  assert.equal(phrase.term, 'Всемирная организация здравоохранения');
  assert.equal(phrase.entries[0].text, 'Всемирная организация здравоохранения, сокращённо ВОЗ');

  // Сокращение остаётся самостоятельным словом
  const short = lexicon.lookupAt('ВОЗ в Женеве', 1);
  assert.equal(short.term, 'ВОЗ');
  assert.equal(short.entries[0].text, 'Всемирная организация здравоохранения (ВОЗ)');

  // Длинное слово побеждает свой короткий префикс
  const longWord = lexicon.lookupAt('токенизатор собран', 4);
  assert.equal(longWord.term, 'токенизатор');
  assert.equal(longWord.entries.length, 1);
  assert.match(longWord.entries[0].text, /tokenizer/);

  // Граница слова: «токен» внутри «псевдотокен» не должно срабатывать
  assert.equal(lexicon.lookupAt('псевдотокен', 7).entries.length, 0, 'суффикс длинного слова — не совпадение');

  // Англоязычная фраза: с первого слова совпадает целиком
  const united = 'joined United Nations in 1945';
  const atStart = lexicon.lookupAt(united, 9);
  assert.equal(atStart.term, 'United Nations');
  assert.equal(atStart.start, 7);
  assert.equal(atStart.end, 21);

  // Курсор на втором слове фразы: ищем только это слово, без растягивания влево
  assert.equal(lexicon.lookupAt(united, 15).entries.length, 0);

  // Кириллическое словосочетание ведёт себя так же
  const hidden = 'это скрытое состояние модели';
  assert.equal(lexicon.lookupAt(hidden, 6).term, 'скрытое состояние');
  assert.equal(lexicon.lookupAt(hidden, 14).entries.length, 0, 'второе слово фразы отдельно не ищется');
});

/* ------------------------------------------------------------------ *
 * Тест 3: нормализация — регистр / пунктуация / полноширинные символы / пробелы
 * ------------------------------------------------------------------ */
test('тест3: регистр, пунктуация, полноширинные символы и пробелы сводятся к одному слову', () => {
  assert.equal(normalize('  ВОЗ,'), 'воз');
  assert.equal(normalize('ＷＨＯ'), 'who', 'NFKC переводит полноширинные символы в обычные');
  assert.equal(normalize('United   Nations!'), 'united nations');
  assert.equal(normalize('ЁЖ'), 'ёж', 'регистр кириллицы схлопывается');

  for (const spelling of ['who', 'Who', 'WHO', 'ＷＨＯ', '(WHO)', '«WHO»', 'WHO.']) {
    const entries = lexicon.lookup(spelling);
    assert.equal(entries.length, 2, `${spelling} должно находить два толкования WHO`);
    assert.equal(entries[0].text, 'ВОЗ');
  }

  // Пробел внутри английской фразы значим: «unitednations» не должно совпадать
  assert.equal(lexicon.lookup('unitednations').length, 0);
  assert.equal(lexicon.lookup('').length, 0);
  assert.equal(lexicon.lookup(null).length, 0, 'нестроковый ввод безопасно возвращает пусто');
});

/* ------------------------------------------------------------------ *
 * Тест 4: позиционирование курсора — русский и смешанный текст
 * ------------------------------------------------------------------ */
test('тест4: tokenAt / lookupAt правильно определяют слово под курсором', () => {
  const text = 'используй API и DSH тут';
  const api = text.indexOf('API');
  const dsh = text.indexOf('DSH');

  assert.deepEqual(tokenAt(text, api + 1), { term: 'API', start: api, end: api + 3 });
  assert.equal(lexicon.lookupAt(text, api + 1).entries[0].text, 'интерфейс прикладного программирования');

  // Курсор на пробеле сразу справа от слова: tokenAt не даёт слова, lookupAt
  // оставляет только что просмотренное слово
  assert.equal(text[api + 3], ' ');
  assert.equal(tokenAt(text, api + 3), null);
  assert.equal(lexicon.lookupAt(text, api + 3).term, 'API');

  // Курсор на одиночном пробеле внутри текста привязывается к левому слову
  assert.equal(lexicon.lookupAt(text, 3).term, 'используй');

  // Кириллица: однобуквенное слово «и» — тоже слово
  assert.deepEqual(tokenAt(text, text.indexOf(' и ') + 1), { term: 'и', start: text.indexOf(' и ') + 1, end: text.indexOf(' и ') + 2 });
  assert.deepEqual(tokenAt(text, dsh + 1), { term: 'DSH', start: dsh, end: dsh + 3 });
  assert.match(lexicon.lookupAt(text, dsh + 1).entries[0].text, /DeepSeek Harness/);

  // Курсор за концом текста подтягивается к последнему слову, отрицательный — к первому
  assert.deepEqual(tokenAt(text, 999), { term: 'тут', start: text.indexOf('тут'), end: text.length });
  assert.deepEqual(tokenAt(text, -5), { term: 'используй', start: 0, end: 9 });
  assert.equal(tokenAt('', 0), null);
  assert.equal(tokenAt(text, Number.NaN), null);
});

/* ------------------------------------------------------------------ *
 * Тест 5: полный путь — обход реального текста по каждому курсору и самопроверка словаря
 * ------------------------------------------------------------------ */
test('тест5: каждое слово словаря находится в реальном тексте, структура словаря проходит самопроверку', () => {
  const report = lexicon.validate();
  assert.equal(report.ok, true, `самопроверка словаря провалилась: ${report.problems.join('; ')}`);

  assert.equal(lexicon.size, Object.keys(SEED_TABLE).length);
  assert.equal(
    lexicon.itemCount,
    Object.values(SEED_TABLE).reduce((n, list) => n + list.length, 0),
  );

  // У каждого слова должно быть хотя бы одно толкование, иначе наведение
  // покажет «слово без содержимого»
  for (const [term, items] of Object.entries(SEED_TABLE)) {
    const entries = lexicon.lookup(term);
    assert.equal(entries.length, items.length, `у «${term}» не совпадает число толкований`);
    assert.ok(entries.every((e) => e.text.length > 0), `у «${term}» есть пустое толкование`);
    assert.deepEqual(
      entries.map((e) => e.index),
      entries.map((_, i) => i + 1),
      `у «${term}» сбилась нумерация`,
    );
  }

  // Реальный текст: обходим каждый курсор, найденное слово обязано
  // накрывать курсор и совпадать с подстрокой текста
  const full = [
    'Я спросил: объясни WHO и United Nations в двух словах',
    'Ответ: WHO — это ВОЗ, она же Всемирная организация здравоохранения; в DSH плагины расширяет Cordis.',
    'Ещё: чем API отличается от LLM и при чём тут DeepSeek',
  ].join('\n');

  const expected = [
    ['WHO', 2],
    ['ВОЗ', 2],
    ['Всемирная организация здравоохранения', 1],
    ['United Nations', 2],
    ['DSH', 2],
    ['Cordis', 2],
    ['API', 3],
    ['LLM', 2],
    ['DeepSeek', 1],
  ];
  let probes = 0;
  for (const [term, count] of expected) {
    const start = full.toLowerCase().indexOf(term.toLowerCase());
    assert.ok(start >= 0, `в тексте нет «${term}»`);
    // Многословные термины находятся только с первого слова, поэтому пробуем
    // курсоры в пределах первого слова.
    const firstWord = term.split(' ')[0];
    for (let cursor = start; cursor < start + firstWord.length; cursor += 1) {
      const found = lexicon.lookupAt(full, cursor);
      probes += 1;
      assert.ok(found.entries.length >= 1, `курсор ${cursor} должен находить толкования`);
      assert.ok(
        found.start <= cursor && cursor < found.end,
        `курсор ${cursor}: диапазон ${found.start}-${found.end} не накрывает курсор`,
      );
      assert.equal(full.slice(found.start, found.end), found.term);
      if (!term.includes(' ')) {
        assert.equal(found.term, term, `курсор ${cursor} должен находить «${term}»`);
        assert.equal(found.entries.length, count, `у «${term}» должно быть ${count} толкований`);
      }
    }
  }
  assert.ok(probes > 30, 'проверок должно хватать на все слова словаря');

  // Порядок стабилен: повторный запрос даёт тот же результат
  assert.deepEqual(lexicon.lookup('WHO'), lexicon.lookup('WHO'));
});
