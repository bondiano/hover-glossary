/**
 * hover-glossary / lexicon.mjs
 *
 * Ядро словаря: слово -> 1..N толкований, а также алгоритм поиска под курсором.
 *
 * Ключевые решения
 * ----------------
 * 1. Хранение: Map<normalizedKey, Entry[]>
 *      - key  = normalize(term): обрезка пунктуации по краям, схлопывание
 *        внутренних пробелов, приведение к нижнему регистру.
 *      - value= упорядоченный массив толкований; индекс 0 — лучшее объяснение,
 *        порядок стабилен и виден снаружи (в примере "1) ВОЗ 2) кто").
 *      - Это суть плагина: у одного слова явно N толкований, без слияния и
 *        дедупликации.
 * 2. Индекс:  разбиение по длине ключа (Map<length, Set<key>>) + maxKeyLength.
 *      Поиск идёт от min(maxKeyLength, cursor + MAX_SCAN) вниз и
 *      останавливается на первом попадании — то есть побеждает самое длинное
 *      совпадение.
 * 3. Позиция курсора: tokenAt(text, cursor)
 *      Слово определяется расширением в обе стороны от позиции курсора/мыши;
 *      работает и для кириллицы, и для латиницы, и для смешанного текста
 *      (CJK-текст режется по символам, слова латиницы и кириллицы читаются
 *      целиком).
 *
 * Файл — чистый модуль без зависимостей: одна и та же реализация
 * импортируется тестами Node и встраивается scripts/build-client.mjs в
 * клиентскую сборку (в браузере import недоступен).
 */

/* ------------------------------------------------------------------ *
 * Нормализация текста
 * ------------------------------------------------------------------ */

const APOSTROPHES = /[\u2018\u2019\u02bc\u02b9`]/g;
const PUNCT_EDGE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
const CJK_SPACE = /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;

/**
 * Приводит любое написание к ключу поиска.
 * `WHO` / `who` / `"who,"` сводятся к одному ключу `who`.
 * @param {unknown} input
 * @returns {string}
 */
export function normalize(input) {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFKC');
  s = s.replace(APOSTROPHES, "'");
  s = s.replace(/\s+/g, ' ');
  // Пробелы между иероглифами считаем типографским шумом.
  // Правило действует только на CJK и не трогает пробелы в русских фразах.
  s = s.replace(CJK_SPACE, '');
  s = s.replace(PUNCT_EDGE, '');
  return s.toLowerCase();
}

/**
 * Нормализация отображаемого термина: обрезаются только внешние пробелы,
 * исходный регистр сохраняется (нужен для показа, не для сравнения).
 * @param {unknown} input
 * @returns {string}
 */
export function displayTerm(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * Курсор -> слово
 * ------------------------------------------------------------------ */

const WORD_CHAR =
  /[\p{L}\p{N}\p{M}\u2019\u02bc'\u05f3\u30fb\u30fc\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/u;

/**
 * Символ границы слова: любая буква/цифра/комбинирующий знак (включая
 * кириллицу и латиницу) плюс несколько типографских апострофов.
 * @param {string} ch @returns {boolean}
 */
export function isWordChar(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return false;
  return WORD_CHAR.test(ch);
}

/**
 * Возвращает слово, в которое попадает `cursor` в `text`.
 * `cursor` может указывать на любой символ слова или на позицию сразу
 * после него.
 * @param {string} text
 * @param {number} cursor
 * @returns {{term:string,start:number,end:number}|null}
 */
export function tokenAt(text, cursor) {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (!Number.isFinite(cursor)) return null;
  let i = Math.max(0, Math.min(text.length, Math.trunc(cursor)));
  // Курсор сразу справа от слова — сдвигаем на символ влево и считаем это
  // слово; настоящий пробел или пунктуация не принадлежат слову, и тогда
  // lookupAt сам решает, откатиться ли к предыдущему слову.
  if (i >= text.length) {
    if (i > 0 && isWordChar(text[i - 1])) i -= 1;
    else return null;
  } else if (!isWordChar(text[i])) {
    return null;
  }
  let start = i;
  let end = i + 1;
  while (start > 0 && isWordChar(text[start - 1])) start -= 1;
  while (end < text.length && isWordChar(text[end])) end += 1;
  return { term: text.slice(start, end), start, end };
}

/**
 * @typedef {object} GlossaryEntry
 * @property {string} text     текст толкования (объяснение)
 * @property {string} [kind]   тип толкования, например «аббр.» / «термин»
 * @property {number} [weight] чем больше, тем выше; равные веса сохраняют порядок вставки
 * @property {string[]} [tags]
 */

/**
 * Lexicon: индекс «слово -> 1..N толкований».
 */
export class Lexicon {
  /**
   * @param {{maxEntriesPerTerm?:number}} [options] сколько толкований оставлять на слово (по умолчанию без ограничения, то есть 1 -> N)
   */
  constructor(options = {}) {
    /** @type {Map<string, GlossaryEntry[]>} */
    this.entries = new Map();
    /** @type {Map<string, string>} нормализованный ключ -> отображаемый термин (регистр сохранён) */
    this.display = new Map();
    /** @type {Map<number, Set<string>>} длина ключа -> набор ключей */
    this.byLength = new Map();
    /** @type {string[]} порядок вставки для детерминированного обхода */
    this.order = [];
    this.maxKeyLength = 0;
    this.maxEntriesPerTerm =
      Number.isFinite(options.maxEntriesPerTerm) && options.maxEntriesPerTerm > 0
        ? Math.trunc(options.maxEntriesPerTerm)
        : Infinity;
  }

  /** Число зарегистрированных слов */
  get size() {
    return this.entries.size;
  }

  /** Общее число толкований */
  get itemCount() {
    let n = 0;
    for (const list of this.entries.values()) n += list.length;
    return n;
  }

  /**
   * Регистрирует слово и его 1..N толкований.
   * @param {string} term
   * @param {Array<string|GlossaryEntry>} items
   * @param {{replace?:boolean}} [opts]
   * @returns {Lexicon} this (цепочка)
   */
  add(term, items, opts = {}) {
    const key = normalize(term);
    if (key.length === 0) return this;
    const list = Array.isArray(items) ? items : [items];
    const incoming = [];
    for (const raw of list) {
      const entry = typeof raw === 'string' ? { text: raw } : raw;
      if (!entry || typeof entry.text !== 'string') continue;
      const text = displayTerm(entry.text);
      if (text.length === 0) continue;
      incoming.push({
        text,
        kind: typeof entry.kind === 'string' ? entry.kind : 'толкование',
        weight: Number.isFinite(entry.weight) ? entry.weight : 0,
        tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
      });
    }
    if (incoming.length === 0) return this;

    const existing = opts.replace === true ? [] : this.entries.get(key) || [];
    const merged = existing.concat(incoming).slice(0, this.maxEntriesPerTerm);
    // Стабильная сортировка: только по weight, при равенстве — порядок вставки
    merged.sort((a, b) => b.weight - a.weight);
    // Перенумерация, чтобы порядок показа совпадал с порядком данных
    merged.forEach((e, i) => {
      e.index = i + 1;
    });

    if (!this.entries.has(key)) {
      this.order.push(key);
      if (!this.byLength.has(key.length)) this.byLength.set(key.length, new Set());
      this.byLength.get(key.length).add(key);
      if (key.length > this.maxKeyLength) this.maxKeyLength = key.length;
    }
    this.entries.set(key, merged);
    this.display.set(key, displayTerm(term));
    return this;
  }

  /**
   * Загружает словарь { term: [entries] } целиком.
   * @param {Record<string, Array<string|GlossaryEntry>>} table
   */
  load(table) {
    for (const term of Object.keys(table)) this.add(term, table[term]);
    return this;
  }

  /** @param {string} keyOrTerm @returns {boolean} */
  has(keyOrTerm) {
    return this.entries.has(normalize(keyOrTerm));
  }

  /**
   * Запрос: слово -> N толкований (копии, вызывающий не может испортить
   * внутреннюю структуру).
   * @param {string} term
   * @returns {GlossaryEntry[]}
   */
  lookup(term) {
    const list = this.entries.get(normalize(term));
    if (!list) return [];
    return list.map((e) => ({ ...e, tags: e.tags ? e.tags.slice() : [] }));
  }

  /**
   * Поиск по курсору: перебираем кандидатов от длинных к коротким и
   * останавливаемся на первом попадании.
   * @param {string} text
   * @param {number} cursor
   * @param {{window?:number}} [opts]
   * @returns {{term:string,key:string,start:number,end:number,entries:GlossaryEntry[]}}
   */
  lookupAt(text, cursor, opts = {}) {
    // Окно чтения вправо: по умолчанию — длина самого длинного слова словаря.
    // Фиксированные 16 символов обрезали бы длинные русские словосочетания.
    const window = Number.isFinite(opts.window)
      ? opts.window
      : this.maxKeyLength > 0 ? this.maxKeyLength : 16;
    let hit = tokenAt(text, cursor);
    // Курсор не попал в слово — три случая:
    //  1) пробел сразу справа от слова -> привязываемся к этому слову,
    //     чтобы подсказка не пропадала у только что просмотренного слова;
    //  2) позиция в пустом месте между пробелами -> идём вправо к
    //     следующему слову и не угадываем слово слева;
    //  3) другой не-словесный символ (пунктуация) сразу после слова ->
    //     тоже привязываемся к левому слову.
    if (!hit) {
      const pos = Math.max(0, Math.min(text.length, Math.trunc(cursor || 0)));
      const prev = pos > 0 ? text[pos - 1] : '';
      const staysLeft = (prev === ' ' || prev === '\t' || !isWordChar(text[pos] === undefined ? '' : text[pos])) && isWordChar(prev);
      if (staysLeft) {
        const left = tokenAt(text, pos - 1);
        if (left) hit = left;
      }
      if (!hit) {
        let next = pos;
        while (next < text.length && !isWordChar(text[next])) next += 1;
        if (next < text.length) return this.lookupAt(text, next, opts);
      }
    }
    const tokenStart = hit ? Math.min(hit.start, Math.max(0, Math.min(text.length, Math.trunc(cursor || 0)))) : 0;
    const tokenEnd = hit ? hit.end : 0;
    const anchored = hit !== null && hit !== undefined;
    // Стартовые позиции-кандидаты: от первого символа токена до самого курсора.
    // Откат влево необходим для CJK: сплошной текст режется на один токен,
    // и CJK-слово должно находиться с любой своей позиции.
    // За первый символ токена не выходим, поэтому чужие токены не захватываем.
    const starts = [];
    if (anchored) {
      const cursorPos = Math.max(0, Math.min(text.length, Math.trunc(cursor || 0)));
      for (let s = tokenStart; s <= cursorPos; s += 1) starts.push(s);
    }
    if (starts.length === 0) {
      starts.push(Math.max(0, Math.min(text.length, Math.trunc(cursor || 0))));
    }
    const cursorPos = anchored ? Math.max(0, Math.min(text.length, Math.trunc(cursor || 0))) : starts[0];
    const candidates = [];
    for (const start of starts) {
      // Каждый старт читает вправо не больше самого длинного слова словаря;
      // но токен под курсором нужно дочитать целиком, иначе внутренние слова
      // длинного CJK-токена внутренние слова будут обрезаны.
      const stop = Math.min(text.length, Math.max(anchored && start === tokenStart ? tokenEnd : 0, start + Math.max(1, window)));
      let sawWordChar = false;
      for (let end = start + 1; end <= stop; end += 1) {
        const ch = text[end - 1];
        if (isWordChar(ch)) {
          sawWordChar = true;
          // Кандидат обязан накрывать курсор, иначе это обрывок слева
          if (end > cursorPos) {
            candidates.push({ key: normalize(text.slice(start, end)), start, end });
          }
          continue;
        }
        if (sawWordChar && (ch === ' ' || ch === '\t') && end < text.length && isWordChar(text[end])) continue;
        break;
      }
    }

    // Сначала самые длинные
    candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    for (const candidate of candidates) {
      const list = this.entries.get(candidate.key);
      if (list && list.length > 0) {
        // Слова на латинице и кириллице требуют границы слова: WHO не должно
        // срабатывать в WHOLE, «токен» — в «токенизатор». У иероглифов границ
        // нет, поэтому зарегистрированные CJK-слова ищутся в сплошном тексте.
        if (blocksWordBoundary(text, candidate.start, candidate.end)) continue;
        return {
          term: text.slice(candidate.start, candidate.end),
          key: candidate.key,
          start: candidate.start,
          end: candidate.end,
          entries: list.map((e) => ({ ...e, tags: e.tags ? e.tags.slice() : [] })),
        };
      }
    }
    // Запасной вариант: слово под курсором целиком
    if (hit) {
      const key = normalize(hit.term);
      const list = this.entries.get(key);
      if (list && list.length > 0) {
        return { term: hit.term, key, start: hit.start, end: hit.end, entries: list.map((e) => ({ ...e })) };
      }
    }
    return { term: hit ? hit.term : '', key: '', start: cursorPos, end: cursorPos, entries: [] };
  }

  /**
   * Полный список толкований (детерминированный порядок: порядок регистрации
   * -> группировка по длине).
   * @returns {Array<{term:string,key:string,entries:GlossaryEntry[]}>}
   */
  list() {
    return this.order.map((key) => ({
      term: this.display.get(key) || key,
      key,
      entries: this.lookup(key),
    }));
  }

  /**
   * Минимальная самопроверка: длина каждого ключа должна совпадать с
   * корзиной, а индексы толкований идти подряд.
   * @returns {{ok:boolean, problems:string[]}}
   */
  validate() {
    const problems = [];
    for (const key of this.order) {
      const list = this.entries.get(key);
      if (!list || list.length === 0) problems.push(`${key}: нет толкований`);
      else list.forEach((e, i) => {
        if (e.index !== i + 1) problems.push(`${key}: сбилась нумерация (${e.index} != ${i + 1})`);
      });
      const bucket = this.byLength.get(key.length);
      if (!bucket || !bucket.has(key)) problems.push(`${key}: ключ не попал в корзину длины`);
    }
    if (this.maxKeyLength > 0 && !this.byLength.has(this.maxKeyLength)) {
      problems.push(`maxKeyLength=${this.maxKeyLength} без своей корзины`);
    }
    return { ok: problems.length === 0, problems };
  }
}

/**
 * Проверяет, что найденный фрагмент не является частью более длинного слова.
 * Проверка применяется к буквам и цифрам латиницы и кириллицы, но не к
 * иероглифам: у CJK нет явных границ слова, там совпадение внутри текста
 * — норма.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {boolean} true, если совпадение нужно отбросить
 */
function blocksWordBoundary(text, start, end) {
  const boundary = /[\p{L}\p{N}_]/u;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const blocks = (ch) => boundary.test(ch) && !cjk.test(ch);
  if (blocks(text[start]) && start > 0 && blocks(text[start - 1])) return true;
  if (blocks(text[end - 1]) && end < text.length && blocks(text[end])) return true;
  return false;
}

/**
 * Удобная точка входа: собрать Lexicon из таблицы.
 * @param {Record<string, Array<string|GlossaryEntry>>} table
 * @param {{maxEntriesPerTerm?:number}} [options]
 * @returns {Lexicon}
 */
export function createLexicon(table, options) {
  return new Lexicon(options).load(table || {});
}
