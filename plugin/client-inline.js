/* Сгенерировано scripts/build-client.mjs, править вручную нельзя; после правок src/ пересоберите */
/* ------------------------------------------------------------------ *
 * Нормализация текста
 * ------------------------------------------------------------------ */

const APOSTROPHES = /[\u2018\u2019\u02bc\u02b9`]/g;
const PUNCT_EDGE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
const CJK_SPACE = /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;


function normalize(input) {
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


function displayTerm(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * Курсор -> слово
 * ------------------------------------------------------------------ */

const WORD_CHAR =
  /[\p{L}\p{N}\p{M}\u2019\u02bc'\u05f3\u30fb\u30fc\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/u;


function isWordChar(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return false;
  return WORD_CHAR.test(ch);
}


function tokenAt(text, cursor) {
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




class Lexicon {
  
  constructor(options = {}) {
    
    this.entries = new Map();
    
    this.display = new Map();
    
    this.byLength = new Map();
    
    this.order = [];
    this.maxKeyLength = 0;
    this.maxEntriesPerTerm =
      Number.isFinite(options.maxEntriesPerTerm) && options.maxEntriesPerTerm > 0
        ? Math.trunc(options.maxEntriesPerTerm)
        : Infinity;
  }

  
  get size() {
    return this.entries.size;
  }

  
  get itemCount() {
    let n = 0;
    for (const list of this.entries.values()) n += list.length;
    return n;
  }

  
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

  
  load(table) {
    for (const term of Object.keys(table)) this.add(term, table[term]);
    return this;
  }

  
  has(keyOrTerm) {
    return this.entries.has(normalize(keyOrTerm));
  }

  
  lookup(term) {
    const list = this.entries.get(normalize(term));
    if (!list) return [];
    return list.map((e) => ({ ...e, tags: e.tags ? e.tags.slice() : [] }));
  }

  
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

  
  list() {
    return this.order.map((key) => ({
      term: this.display.get(key) || key,
      key,
      entries: this.lookup(key),
    }));
  }

  
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


function blocksWordBoundary(text, start, end) {
  const boundary = /[\p{L}\p{N}_]/u;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const blocks = (ch) => boundary.test(ch) && !cjk.test(ch);
  if (blocks(text[start]) && start > 0 && blocks(text[start - 1])) return true;
  if (blocks(text[end - 1]) && end < text.length && blocks(text[end])) return true;
  return false;
}


function createLexicon(table, options) {
  return new Lexicon(options).load(table || {});
}

/* ---- встроенный словарь (из src/seed-data.mjs) ---- */
const SEED_TABLE = {
  // Пример из требований: 1 -> 2
  WHO: [
    { text: 'ВОЗ', kind: 'аббр.', weight: 100, tags: ['междунар. организация'] },
    { text: 'кто', kind: 'местоимение', weight: 10, tags: ['английское слово'] },
  ],
  API: [
    { text: 'интерфейс прикладного программирования', kind: 'аббр.', weight: 100, tags: ['ПО'] },
    { text: 'индекс загрязнения воздуха', kind: 'аббр.', weight: 20, tags: ['экология'] },
    { text: 'Американский институт нефти (обозначение стандарта)', kind: 'аббр.', weight: 10, tags: ['стандарт'] },
  ],
  DSH: [
    { text: 'DeepSeek Harness (продукт, в котором работает этот терминал)', kind: 'аббр.', weight: 100 },
    { text: 'аппаратное обеспечение цифровой подписи', kind: 'аббр.', weight: 20, tags: ['железо'] },
  ],
  Cordis: [
    { text: 'среда выполнения плагинов и фреймворк внедрения зависимостей DSH', kind: 'термин', weight: 100, tags: ['фреймворк'] },
    { text: 'лёгкое ядро плагинов с аспектно-ориентированным подходом', kind: 'термин', weight: 10 },
  ],
  LLM: [
    { text: 'большая языковая модель', kind: 'аббр.', weight: 100, tags: ['ИИ'] },
    { text: 'управление логическими каналами (сетевой уровень)', kind: 'аббр.', weight: 10, tags: ['сеть'] },
  ],
  'ВОЗ': [
    { text: 'Всемирная организация здравоохранения (ВОЗ)', kind: 'междунар. организация', weight: 100 },
    { text: 'одно из специализированных учреждений ООН, штаб-квартира в Женеве', kind: 'пояснение', weight: 50 },
  ],
  'Всемирная организация здравоохранения': [{ text: 'Всемирная организация здравоохранения, сокращённо ВОЗ', kind: 'междунар. организация', weight: 100 }],
  'United Nations': [
    { text: 'Организация Объединённых Наций (ООН)', kind: 'междунар. организация', weight: 100 },
    { text: 'межправительственная международная организация, основанная в 1945 году', kind: 'пояснение', weight: 50 },
  ],
  DeepSeek: [
    { text: 'DeepSeek (разработчик этой модели)', kind: 'имя собств.', weight: 100 },
  ],
  PTY: [
    { text: 'псевдотерминал (pseudo-terminal)', kind: 'аббр.', weight: 100, tags: ['система'] },
    { text: 'pty — это сохраняемая интерактивная сессия терминала', kind: 'возможность', weight: 20, tags: ['DSH'] },
  ],

  // ===== Словарь инференса моделей (по документации и исходникам GLM-5.3-Flash / vLLM Ascend) =====

  // —— Основы инференса ——
  token: [
    { text: 'токен: дискретная единица, обрабатываемая моделью за один раз, — символ, фрагмент слова или спецсимвол; ID — просто номер', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'токен': [
    { text: 'то же, что token; нельзя приравнивать число иероглифов к числу токенов', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  tokenizer: [
    { text: 'токенизатор: превращает текст в целочисленные ID и обратно; шаблон чата добавляет спецметки ролей', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'токенизатор': [
    { text: 'то же, что tokenizer: двусторонний преобразователь текста и token ID', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  embedding: [
    { text: 'эмбеддинг: по таблице весов превращает token ID в вычислимый числовой вектор', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'эмбеддинг': [
    { text: 'то же, что embedding: отображение token ID в вычислимый вектор', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'hidden state': [
    { text: 'скрытое состояние: внутреннее представление после обработки слоем, а не готовый читаемый ответ', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'скрытое состояние': [
    { text: 'hidden state: внутреннее представление, передаваемое между слоями Decoder', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  logits: [
    { text: 'логиты: ненормированные оценки каждого кандидата в словаре; после LogitsProcessor идут в сэмплирование', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  sampling: [
    { text: 'сэмплирование: выбор следующего токена по logits, температуре и top-k/top-p; при температуре 0 обычно жадный выбор', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'сэмплирование': [
    { text: 'то же, что sampling: выбор следующего токена из словаря по оценкам и температуре', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'top-k': [
    { text: 'сэмплирование только из k кандидатов с наибольшими оценками; top-k в маршрутизации MoE — число экспертов на токен, это другое понятие', kind: 'термин', weight: 100, tags: ['сэмплирование'] },
  ],
  'top-p': [
    { text: 'ядерное сэмплирование: выбор только из минимального набора кандидатов с суммарной вероятностью p', kind: 'термин', weight: 100, tags: ['сэмплирование'] },
  ],
  prefill: [
    { text: 'предзаполнение: обработка нескольких токенов подсказки за раз с построением истории; в GLM соответствует ветке chunk в KDA', kind: 'термин', weight: 100, tags: ['стадии инференса'] },
  ],
  'предзаполнение': [
    { text: 'то же, что prefill: параллельная обработка всей подсказки и построение кэша/состояния', kind: 'термин', weight: 100, tags: ['стадии инференса'] },
  ],
  decode: [
    { text: 'пошаговое декодирование: выбранный на прошлом шаге токен подаётся в модель ради следующего; соответствует ветке recurrent в KDA', kind: 'термин', weight: 100, tags: ['стадии инференса'] },
    { text: 'декодирование: обратное превращение token ID в текст (со стороны токенизатора)', kind: 'термин', weight: 10, tags: ['основы инференса'] },
  ],
  'пошаговое декодирование': [
    { text: 'то же, что стадия decode: авторегрессионная генерация по токену', kind: 'термин', weight: 100, tags: ['стадии инференса'] },
  ],
  'chunked prefill': [
    { text: 'чанковое предзаполнение: длинная подсказка делится на раунды; следующий чанк читает состояния conv/recurrent/tail предыдущего', kind: 'термин', weight: 100, tags: ['стадии инференса'] },
  ],
  'чанковое предзаполнение': [
    { text: 'то же, что chunked prefill: длинная подсказка обрабатывается раундами в пределах бюджета max-num-batched-tokens', kind: 'термин', weight: 100, tags: ['стадии инференса'] },
  ],
  'prefix caching': [
    { text: 'кэш префиксов: повторное использование кэша вычисленного префикса; в гибридных моделях все кэшируемые состояния должны совпасть на общей границе, tail не участвует в хеше', kind: 'термин', weight: 100, tags: ['кэш'] },
  ],
  'кэш префиксов': [
    { text: 'то же, что prefix caching; включение не значит, что префикс любой длины переиспользует все состояния', kind: 'термин', weight: 100, tags: ['кэш'] },
  ],
  batch: [
    { text: 'батч: несколько запросов или токенов, считаемых вместе за один раунд планирования; число запросов и число токенов — разные величины', kind: 'термин', weight: 100, tags: ['планировщик'] },
  ],
  'батч': [
    { text: 'то же, что batch; больший батч повышает общую пропускную способность, но увеличивает очередь и ожидание одного запроса', kind: 'термин', weight: 100, tags: ['планировщик'] },
  ],
  forward: [
    { text: 'прямой проход: вычисление представлений с фиксированными весами; не равен полному чат-сервису', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'прямой проход': [
    { text: 'то же, что forward: один проход модели от входа к hidden states/logits', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'KV cache': [
    { text: 'KV-кэш: хранит представления ключей/значений для чтения истории вниманием и избегает пересчёта; MLA в GLM использует сжатый латентный вектор', kind: 'термин', weight: 100, tags: ['кэш'] },
  ],
  'KV-кэш': [
    { text: 'то же, что KV cache; рекуррентное/свёрточное состояние KDA — иная история, это не KV cache', kind: 'термин', weight: 100, tags: ['кэш'] },
  ],
  'веса': [
    { text: 'weights: параметры, сохранённые после обучения и загружаемые load_weights на устройство; отличаются от активаций', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'активации': [
    { text: 'activations: промежуточные значения текущего входа, вычисленные в forward; основной тип — BF16', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'квантизация': [
    { text: 'quantization: представление части весов/активаций в низкой разрядности ради экономии ресурсов, может влиять на точность; не одинаковый режим для всей модели', kind: 'термин', weight: 100, tags: ['квантизация'] },
  ],
  'спекулятивное декодирование': [
    { text: 'speculative decoding: черновик предлагает несколько токенов, целевая модель проверяет и принимает только часть', kind: 'термин', weight: 100, tags: ['спекулятивное декодирование'] },
  ],
  'speculative decoding': [
    { text: 'спекулятивное декодирование: предложения draft + проверка целевой моделью; в vLLM включается через --speculative-config', kind: 'термин', weight: 100, tags: ['спекулятивное декодирование'] },
  ],
  draft: [
    { text: 'черновик (модель/токен): малая модель или голова, предлагающая кандидатов при спекулятивном декодировании; черновик GLM принудительно в eager', kind: 'термин', weight: 100, tags: ['спекулятивное декодирование'] },
  ],
  'черновик': [
    { text: 'кандидатные токены, предложенные головой MTP при спекулятивном декодировании; конечное состояние отвергнутого черновика не становится историей', kind: 'термин', weight: 100, tags: ['спекулятивное декодирование'] },
  ],
  scheduler: [
    { text: 'планировщик: решает, какие запросы и сколько токенов считать в текущем раунде, и выдаёт блоки кэша', kind: 'термин', weight: 100, tags: ['планировщик'] },
  ],
  'планировщик': [
    { text: 'то же, что scheduler: отвечает за бюджет токенов, состояния запросов и выдачу кэша', kind: 'термин', weight: 100, tags: ['планировщик'] },
  ],
  'model runner': [
    { text: 'model runner: готовит тензоры и метаданные, вызывает forward модели, затем сэмплирует', kind: 'термин', weight: 100, tags: ['фреймворк'] },
  ],
  loader: [
    { text: 'загрузчик: переносит веса с диска в модули и приводит к раскладке, требуемой операторами; загрузка ≠ инференс', kind: 'термин', weight: 100, tags: ['фреймворк'] },
  ],
  'загрузчик': [
    { text: 'то же, что loader: отображение весов, шардирование и раскладка квантизации', kind: 'термин', weight: 100, tags: ['фреймворк'] },
  ],
  safetensors: [
    { text: 'безопасный формат файлов тензорных весов; загрузчик vLLM по умолчанию перебирает safetensors и передаёт их в отображение весов', kind: 'термин', weight: 100, tags: ['веса'] },
  ],

  // —— Метрики производительности ——
  TTFT: [
    { text: 'задержка первого токена (Time To First Token): от отправки запроса до первого токена, включая очередь, обработку входа и prefill', kind: 'аббр.', weight: 100, tags: ['метрики'] },
  ],
  TPOT: [
    { text: 'время на выходной токен (Time Per Output Token): (общее время генерации − TTFT)/(число выходных токенов − 1)', kind: 'аббр.', weight: 100, tags: ['метрики'] },
  ],
  ITL: [
    { text: 'межтокенная задержка (Inter-Token Latency): интервал между соседними выходами, удобна для отслеживания рывков и хвостовой задержки', kind: 'аббр.', weight: 100, tags: ['метрики'] },
  ],
  throughput: [
    { text: 'пропускная способность: сколько запросов или токенов завершается в секунду; нужно указывать вход/выход, конкурентность и методику подсчёта', kind: 'термин', weight: 100, tags: ['метрики'] },
  ],
  'пропускная способность': [
    { text: 'то же, что throughput; по одному tokens/s нельзя судить об отзывчивости', kind: 'термин', weight: 100, tags: ['метрики'] },
  ],
  'пиковая память': [
    { text: 'peak device memory: пиковый объём памяти устройства с весами, кэшем, активациями, графами и рабочей областью', kind: 'термин', weight: 100, tags: ['метрики'] },
  ],

  // —— Механизмы архитектуры модели ——
  KDA: [
    { text: 'Kimi Delta Attention (линейное внимание Kimi Delta): собирает историю в рекуррентном матричном состоянии, а короткая причинная свёртка хранит окно последних проекций', kind: 'аббр.', weight: 100, tags: ['внимание'] },
    { text: 'prefill идёт по ветке chunk, decode — по ветке recurrent; реализация требует активаций BF16 и head_dim=128', kind: 'пояснение', weight: 50, tags: ['GLM'] },
  ],
  MLA: [
    { text: 'Multi-head Latent Attention (многоголовое латентное внимание): хранит историю внимания в низкоранговом сжатом latent KV', kind: 'аббр.', weight: 100, tags: ['внимание'] },
    { text: 'проекции MLA включают низкоранговый Q и latent KV; текущий путь GLM — NoPE (размерность rope равна 0)', kind: 'пояснение', weight: 50, tags: ['GLM'] },
  ],
  DSA: [
    { text: 'DeepSeek Sparse Attention (разреженное внимание DeepSeek): читает только выбранные позиции истории, а не все', kind: 'аббр.', weight: 100, tags: ['внимание'] },
  ],
  SFA: [
    { text: 'Sparse Flash Attention (разреженное Flash-внимание): общий бэкенд, получает разреженный индекс и читает основной latent KV', kind: 'аббр.', weight: 100, tags: ['внимание'] },
    { text: 'A5 использует cann_ops_transformer.sparse_flash_mla, A2/A3 — npu_sparse_flash_attention', kind: 'пояснение', weight: 50, tags: ['Ascend'] },
  ],
  KPool: [
    { text: 'key pooling (пулинг ключей): каждые R индексных ключей сводятся в один пул-вектор для top-k, это не ещё одна полная копия текста', kind: 'термин', weight: 100, tags: ['внимание'] },
    { text: 'при index_topk=2048 и R=4 выбирается до 512 полных пулов плюс не более 3 tail-токенов', kind: 'пояснение', weight: 50, tags: ['GLM'] },
  ],
  'пулинг ключей': [
    { text: 'то же, что KPool; сжимается индексный K для выбора позиций, основной кэш хранит полный latent KV', kind: 'термин', weight: 100, tags: ['внимание'] },
  ],
  'lightning indexer': [
    { text: 'lightning indexer: лёгкий индексный модуль, считает индексные оценки и делает top-k в разреженном внимании', kind: 'термин', weight: 100, tags: ['внимание'] },
  ],
  'latent KV': [
    { text: 'сжатое латентное представление ключей и значений MLA; основной кэш хранит его блоками для чтения после выбора разреженным индексом', kind: 'термин', weight: 100, tags: ['внимание'] },
  ],
  'латентный вектор': [
    { text: 'latent: внутреннее представление после низкорангового сжатия, например latent KV в MLA', kind: 'термин', weight: 100, tags: ['внимание'] },
  ],
  MoE: [
    { text: 'Mixture of Experts (смесь экспертов): router выбирает top-k экспертов для каждого токена и добавляет результат общего эксперта', kind: 'аббр.', weight: 100, tags: ['архитектура'] },
    { text: 'всего около 320B параметров, ~18B активных на токен: активируется лишь часть экспертов, но загружать нужно не только 18B весов', kind: 'пояснение', weight: 50, tags: ['GLM'] },
  ],
  'MoE (термин)': [
    { text: 'то же, что MoE; в GLM первые три слоя MLP — dense, остальные — sparse/MoE', kind: 'термин', weight: 100, tags: ['архитектура'] },
  ],
  router: [
    { text: 'router/гейт: в MoE формирует оценки маршрутизации [T,E] и выбирает top-k экспертов; в официальной конфигурации FP32', kind: 'термин', weight: 100, tags: ['архитектура'] },
  ],
  'общий эксперт': [
    { text: 'shared expert: постоянный эксперт, через который проходят все токены; его результат складывается с результатами маршрутизируемых экспертов', kind: 'термин', weight: 100, tags: ['архитектура'] },
  ],
  mHC: [
    { text: 'Manifold-Constrained Hyper-Connections (гиперсвязи с ограничением на многообразии): ограниченное смешивание нескольких остаточных потоков', kind: 'аббр.', weight: 100, tags: ['архитектура'] },
    { text: 'остаточные потоки [T,n,H], параметры смешивания FP32, матрица смешивания ограничивается итерациями Sinkhorn; в слоях MTP не используется', kind: 'пояснение', weight: 50, tags: ['GLM'] },
  ],
  MTP: [
    { text: 'Multi-Token Prediction (предсказание нескольких токенов): дополнительная голова, поставляющая черновики для спекулятивного декодирования', kind: 'аббр.', weight: 100, tags: ['спекулятивное декодирование'] },
    { text: 'num_nextn_predict_layers=1 не значит, что предлагается только один токен: proposer может итеративно вызывать тот же слой', kind: 'пояснение', weight: 50, tags: ['GLM'] },
  ],
  MLP: [
    { text: 'Multi-Layer Perceptron (многослойный перцептрон): сеть прямого распространения с проекциями gate/up, перемножением с гейтом SiLU и проекцией down', kind: 'аббр.', weight: 100, tags: ['архитектура'] },
  ],
  RMSNorm: [
    { text: 'Root Mean Square Layer Normalization (нормализация по среднеквадратичному): управляет масштабом чисел, а не превращает активации в вероятности', kind: 'аббр.', weight: 100, tags: ['архитектура'] },
  ],
  RoPE: [
    { text: 'Rotary Position Embedding (вращательное позиционное кодирование): кодирует позицию с помощью поворота', kind: 'аббр.', weight: 100, tags: ['позиционное кодирование'] },
  ],
  NoPE: [
    { text: 'No Positional Embedding: путь без размерностей RoPE; KPool в GLM требует qk_rope_head_dim=0', kind: 'аббр.', weight: 100, tags: ['позиционное кодирование'] },
    { text: 'нулевая ширина rope не отменяет необходимости передавать позицию запроса и причинную маску', kind: 'пояснение', weight: 50, tags: ['GLM'] },
  ],
  'RoPE (термин)': [
    { text: 'то же, что RoPE: позиция кодируется в Q/K вращательным преобразованием', kind: 'термин', weight: 100, tags: ['позиционное кодирование'] },
  ],
  GEMM: [
    { text: 'General Matrix Multiply (общее матричное умножение); KDA объединяет шесть проекций q/k/v/beta/gate в один GEMM', kind: 'аббр.', weight: 100, tags: ['оператор'] },
  ],
  SiLU: [
    { text: 'Sigmoid Linear Unit: часто используемая в MLP активация с гейтом', kind: 'аббр.', weight: 100, tags: ['оператор'] },
  ],
  SwiGLU: [
    { text: 'путь прямого распространения с гейтом SwiGLU; при непустом swiglu_limit используется вариант с обрезанием', kind: 'термин', weight: 100, tags: ['оператор'] },
  ],
  'causal convolution': [
    { text: 'причинная свёртка: короткая свёртка только по последним позициям; в KDA ширина 2–4, в MTP обязательна 4', kind: 'термин', weight: 100, tags: ['оператор'] },
  ],
  'причинная свёртка': [
    { text: 'то же, что causal convolution: короткая свёртка, хранящая окно последних проекций в KDA', kind: 'термин', weight: 100, tags: ['оператор'] },
  ],
  'рекуррентное состояние': [
    { text: 'recurrent state: сводка истории в виде матрицы [d,d] на каждую голову KDA, по умолчанию FP32; размер не растёт линейно с длиной истории', kind: 'термин', weight: 100, tags: ['KDA'] },
  ],
  'состояние свёртки': [
    { text: 'conv state: скользящее окно последних проекций короткой свёртки KDA, по умолчанию BF16, как и модель', kind: 'термин', weight: 100, tags: ['KDA'] },
  ],
  'визуальный ствол': [
    { text: 'vision tower: патчи изображения проходят Conv3d patch embedding, визуальный Transformer, даунсэмплинг и PatchMerger, превращаясь в визуальные векторы ширины H', kind: 'термин', weight: 100, tags: ['мультимодальность'] },
  ],

  // —— Стратегии параллелизма ——
  TP: [
    { text: 'Tensor Parallelism (тензорный параллелизм): головы/матрицы одного слоя распределяются по картам', kind: 'аббр.', weight: 100, tags: ['параллелизм'] },
    { text: 'в основном сценарии GLM TP8; уменьшает веса/головы на rank, но увеличивает коммуникации', kind: 'пояснение', weight: 50, tags: ['GLM'] },
  ],
  'тензорный параллелизм': [
    { text: 'то же, что TP: деление по внутренним размерностям слоя между картами', kind: 'термин', weight: 100, tags: ['параллелизм'] },
  ],
  DP: [
    { text: 'Data Parallelism (параллелизм по данным): разные rank обрабатывают разные запросы', kind: 'аббр.', weight: 100, tags: ['параллелизм'] },
  ],
  'параллелизм по данным': [
    { text: 'то же, что DP: разделение по запросам', kind: 'термин', weight: 100, tags: ['параллелизм'] },
  ],
  EP: [
    { text: 'Expert Parallelism (параллелизм по экспертам): эксперты MoE распределяются по устройствам, нужна межранговая коммуникация экспертов', kind: 'аббр.', weight: 100, tags: ['параллелизм'] },
  ],
  'параллелизм по экспертам': [
    { text: 'то же, что EP; руководство GLM требует --enable-expert-parallel', kind: 'термин', weight: 100, tags: ['параллелизм'] },
  ],
  PP: [
    { text: 'Pipeline Parallelism (конвейерный параллелизм): модель делится по слоям на сегменты', kind: 'аббр.', weight: 100, tags: ['параллелизм'] },
    { text: 'в текущем исходнике GLM явно отключён; отметка в матрице поддержки не доказывает работоспособность', kind: 'пояснение', weight: 50, tags: ['GLM'] },
  ],
  'конвейерный параллелизм': [
    { text: 'то же, что PP: модель делится по слоям между устройствами', kind: 'термин', weight: 100, tags: ['параллелизм'] },
  ],
  CP: [
    { text: 'Context Parallelism (параллелизм по контексту): разделение длинной истории последовательности', kind: 'аббр.', weight: 100, tags: ['параллелизм'] },
  ],
  'параллелизм по контексту': [
    { text: 'то же, что CP; бэкенд KPool в GLM отклоняет PCP/DCP со значением больше 1', kind: 'термин', weight: 100, tags: ['параллелизм'] },
  ],
  PCP: [
    { text: 'Prefill Context Parallelism: параллелизм по контексту на стадии prefill', kind: 'аббр.', weight: 100, tags: ['параллелизм'] },
  ],
  DCP: [
    { text: 'Decode Context Parallelism: параллелизм по контексту на стадии decode', kind: 'аббр.', weight: 100, tags: ['параллелизм'] },
  ],
  SP: [
    { text: 'Sequence Parallelism (параллелизм по последовательности): деление по оси токенов, перед вниманием gather, после — reduce-scatter; не равен шардированию кэша в CP', kind: 'аббр.', weight: 100, tags: ['параллелизм'] },
  ],
  'параллелизм по последовательности': [
    { text: 'то же, что SP: деление по оси токенов', kind: 'термин', weight: 100, tags: ['параллелизм'] },
  ],
  'all-gather': [
    { text: 'коллективная операция: собирает фрагменты всех rank в полный тензор', kind: 'термин', weight: 100, tags: ['коммуникации'] },
  ],
  'reduce-scatter': [
    { text: 'коллективная операция: выполняет редукцию и раздаёт результат фрагментами по rank', kind: 'термин', weight: 100, tags: ['коммуникации'] },
  ],
  'all-to-all': [
    { text: 'коллективная операция: попарный обмен данными между rank, часто используется при маршрутизации экспертов MoE', kind: 'термин', weight: 100, tags: ['коммуникации'] },
  ],

  // —— Числовые типы и квантизация ——
  dtype: [
    { text: 'тип чисел тензора (например, BF16/FP32); не является частью shape', kind: 'термин', weight: 100, tags: ['числа'] },
  ],
  BF16: [
    { text: 'Brain Floating Point 16: 16-битный формат brain float; основной dtype активаций GLM, обязателен для KDA', kind: 'аббр.', weight: 100, tags: ['числа'] },
  ],
  FP32: [
    { text: '32-bit Floating Point: 32-битная плавающая точка; по умолчанию для параметров смешивания mHC, рекуррентного состояния KDA и tail в KPool', kind: 'аббр.', weight: 100, tags: ['числа'] },
  ],
  FP16: [
    { text: '16-битная плавающая точка половинной точности; KDA в GLM отклоняет активации FP16', kind: 'аббр.', weight: 100, tags: ['числа'] },
  ],
  FP8: [
    { text: '8-битный формат квантизации с плавающей точкой; официальная конфигурация GLM — нативный FP8, это отдельный от квантизации ModelSlim путь загрузки', kind: 'аббр.', weight: 100, tags: ['квантизация'] },
  ],
  MXFP8: [
    { text: 'формат квантизации FP8 с микроскейлингом по векторам; в основном сценарии 950 используется веса ModelSlim GLM-5.3-Flash-w8a8-mxfp8', kind: 'аббр.', weight: 100, tags: ['квантизация'] },
  ],
  W8A8: [
    { text: 'схема квантизации: веса 8 бит, активации 8 бит; схемы A2/A3 и 950 различаются', kind: 'аббр.', weight: 100, tags: ['квантизация'] },
  ],
  W4A4C8: [
    { text: 'схема квантизации: веса 4 бита, активации 4 бита, кэш 8 бит; относится к конфигурации GLM-5.2 и не переносится на GLM-5.3-Flash', kind: 'аббр.', weight: 100, tags: ['квантизация'] },
  ],
  INT8: [
    { text: '8-битная целочисленная квантизация; в GLM нельзя все активации называть INT8 — схему каждого слоя задаёт описание квантизации', kind: 'аббр.', weight: 100, tags: ['квантизация'] },
  ],
  C8: [
    { text: '8-битная квантизация KV cache; основной KV в SFA NoPE для GLM явно отвергает enable_sparse_sfa_c8', kind: 'аббр.', weight: 100, tags: ['квантизация'] },
  ],
  ModelSlim: [
    { text: 'инструментарий сжатия моделей Ascend и его квантованные артефакты; по quant_model_description.json выбирает схему linear/MoE для каждого слоя', kind: 'имя собств.', weight: 100, tags: ['квантизация'] },
  ],
  'де-квантизация': [
    { text: 'dequant: восстановление квантованных весов в более широкое представление; часть весов MLA/indexer из FP8 checkpoint при загрузке де-квантизуется в BF16', kind: 'термин', weight: 100, tags: ['квантизация'] },
  ],

  // —— Кэш и планирование ——
  'block table': [
    { text: 'таблица блоков: хранит для каждого запроса отображение логических блоков в физические ID', kind: 'термин', weight: 100, tags: ['кэш'] },
  ],
  'таблица блоков': [
    { text: 'то же, что block table; позиция p соответствует логическому блоку p//L и смещению p%L', kind: 'термин', weight: 100, tags: ['кэш'] },
  ],
  'slot mapping': [
    { text: 'отображение слотов: задаёт каждому токену раунда конкретную позицию записи в кэш; основной slot = block_id*L + p%L', kind: 'термин', weight: 100, tags: ['кэш'] },
  ],
  'отображение слотов': [
    { text: 'то же, что slot mapping: создаётся metadata builder для операторов', kind: 'термин', weight: 100, tags: ['кэш'] },
  ],
  BlockPool: [
    { text: 'пул физических блоков кэша vLLM: группы кэша берут из одного пула разные ID; общий базовый тензор не значит, что два активных запроса делят слот состояния', kind: 'термин', weight: 100, tags: ['кэш'] },
  ],
  KVCacheManager: [
    { text: 'менеджер кэша vLLM: выдаёт и освобождает блоки запросов; GLM явно отвергает hybrid KV cache manager', kind: 'термин', weight: 100, tags: ['кэш'] },
  ],
  tail: [
    { text: 'хвостовой кэш KPool: приватный для запроса FP32 кольцевой блок с raw K/gate незавершённого пула; не попадает в prefix cache и не разделяется', kind: 'термин', weight: 100, tags: ['KPool'] },
  ],
  'слот состояния': [
    { text: 'state slot: позиция рекуррентного/свёрточного состояния KDA на каждый запрос; новый запрос должен логически обнулить её, а не наследовать остатки', kind: 'термин', weight: 100, tags: ['KDA'] },
  ],

  // —— Режимы исполнения и оптимизация ——
  eager: [
    { text: 'режим немедленного исполнения: граф не записывается, удобно для отладки; включается принудительно через --enforce-eager', kind: 'термин', weight: 100, tags: ['режим исполнения'] },
  ],
  'CUDA graph': [
    { text: 'графовое исполнение: запись/воспроизведение вызовов устройства снижает накладные расходы launch; на Ascend соответствует ACL Graph, а поле CLI по-прежнему cudagraph_mode', kind: 'термин', weight: 100, tags: ['режим исполнения'] },
  ],
  'ACL Graph': [
    { text: 'графовое исполнение Ascend Computing Language; в руководстве выбран FULL_DECODE_ONLY — растут время прогрева и память', kind: 'термин', weight: 100, tags: ['режим исполнения'] },
  ],
  'режим графа': [
    { text: 'режим графа: запись и воспроизведение вызовов устройства; не стоит ждать эффекта графа одновременно с enforce-eager', kind: 'термин', weight: 100, tags: ['режим исполнения'] },
  ],
  'фьюзинг': [
    { text: 'fusion: объединение операторов сокращает промежуточные тензоры и число launch; шесть в один — структурное изменение, а не шестикратное ускорение', kind: 'термин', weight: 100, tags: ['оптимизация'] },
  ],
  overlap: [
    { text: 'перекрытие: независимые вычисления/коммуникации выполняются одновременно; multistream_overlap_shared_expert по умолчанию выключен', kind: 'термин', weight: 100, tags: ['оптимизация'] },
  ],
  stream: [
    { text: 'поток: очередь задач устройства для перекрытия вычислений и коммуникаций', kind: 'термин', weight: 100, tags: ['оптимизация'] },
  ],

  // —— Железо и платформа ——
  NPU: [
    { text: 'Neural Processing Unit (нейропроцессор): ускоритель Ascend для ИИ; основные вычисления GLM идут на NPU', kind: 'аббр.', weight: 100, tags: ['железо'] },
  ],
  CANN: [
    { text: 'Compute Architecture for Neural Networks (гетерогенная вычислительная архитектура Ascend): программный стек драйверов и библиотек операторов', kind: 'аббр.', weight: 100, tags: ['Ascend'] },
    { text: 'общий адаптер SparseFlashMla для A5 требует согласованных CANN 9.2 и cann_ops_transformer', kind: 'пояснение', weight: 50, tags: ['Ascend'] },
  ],
  AscendC: [
    { text: 'язык/фреймворк разработки пользовательских операторов Ascend; реализует низкоуровневые вычисления KDA, свёрток, mHC и разреженного внимания', kind: 'термин', weight: 100, tags: ['Ascend'] },
  ],
  torch_npu: [
    { text: 'библиотека адаптации PyTorch к NPU, предоставляющая интерфейсы операторов устройства', kind: 'имя собств.', weight: 100, tags: ['Ascend'] },
  ],
  Triton: [
    { text: 'Python-ориентированный компилятор для написания ядер устройства; в GLM применяется для пулинга индексов, записи tail и слияния входов MTP', kind: 'имя собств.', weight: 100, tags: ['оператор'] },
  ],
  HCCL: [
    { text: 'Huawei Collective Communication Library (библиотека коллективных коммуникаций Huawei): основа обмена между картами и узлами', kind: 'аббр.', weight: 100, tags: ['Ascend'] },
  ],
  Gloo: [
    { text: 'библиотека коллективных коммуникаций на стороне CPU; при двухузловом развёртывании нужно верно задать сетевой интерфейс GLOO_SOCKET_IFNAME', kind: 'имя собств.', weight: 100, tags: ['коммуникации'] },
  ],
  '950DT': [
    { text: 'Ascend 950DT: основная машина руководства GLM — 8×96GB, TP8, DP1, EP, отдельный образ MXFP8', kind: 'модель', weight: 100, tags: ['железо'] },
  ],
  '910B': [
    { text: 'ускоритель Ascend 910B; модель из базового образа общего Dockerfile, это не перечень образов 950', kind: 'модель', weight: 100, tags: ['железо'] },
  ],
  OOM: [
    { text: 'Out Of Memory (нехватка памяти): сначала определите, где это — при загрузке, выдаче кэша или graph capture', kind: 'аббр.', weight: 100, tags: ['сбой'] },
  ],
  'npu-smi': [
    { text: 'командная утилита управления устройствами Ascend для проверки физических карт и логических устройств на месте', kind: 'инструмент', weight: 100, tags: ['железо'] },
  ],

  // —— Фреймворки и модели ——
  vLLM: [
    { text: 'открытый фреймворк инференса и обслуживания больших моделей; в этом каталоге изучается его ветка плагина Ascend', kind: 'имя собств.', weight: 100, tags: ['фреймворк'] },
  ],
  'vllm-ascend': [
    { text: 'плагин платформы Ascend для vLLM: регистрирует NPUPlatform, настраивает операторы и реализации моделей', kind: 'имя собств.', weight: 100, tags: ['фреймворк'] },
  ],
  'GLM-5.3-Flash': [
    { text: 'мультимодальная генеративная модель Zhipu: около 320B параметров, ~18B активных на токен; гибридная архитектура KDA+MLA', kind: 'имя собств.', weight: 100, tags: ['модель'] },
    { text: '45 текстовых слоёв: 34 с linear_attention (KDA) и 11 разреженного внимания', kind: 'пояснение', weight: 50, tags: ['модель'] },
  ],
  glm5_next: [
    { text: 'model_type верхнего уровня для GLM-5.3-Flash; текстовый подконфиг glm5_next_text, визуальный glm5_next_vision', kind: 'идентификатор', weight: 100, tags: ['модель'] },
  ],
  Glm5Next: [
    { text: 'префикс локальных классов реализации GLM-5.3-Flash в vllm-ascend; имя архитектуры Glm5NextForConditionalGeneration', kind: 'идентификатор', weight: 100, tags: ['модель'] },
  ],
  EngineArgs: [
    { text: 'набор аргументов движка vLLM: из аргументов CLI выводит итоговую конфигурацию по модели, железу и usage context', kind: 'идентификатор', weight: 100, tags: ['фреймворк'] },
  ],
  AsyncLLM: [
    { text: 'асинхронный клиент движка vLLM: точка входа для потока запросов, межпроцессных коммуникаций и шагов движка', kind: 'идентификатор', weight: 100, tags: ['фреймворк'] },
  ],
  transformers: [
    { text: 'библиотека моделей Hugging Face; анализ GLM зафиксирован на transformers 5.14.1, а указанная в официальной конфигурации версия 5.16.0 — не повод молча обновляться', kind: 'имя собств.', weight: 100, tags: ['фреймворк'] },
  ],
  LoRA: [
    { text: 'Low-Rank Adaptation (низкоранговая адаптация): добавление малых матриц к весам при дообучении; в основном сценарии GLM комбинация не проверена', kind: 'аббр.', weight: 100, tags: ['фреймворк'] },
  ],
  EAGLE: [
    { text: 'метод черновика для спекулятивного декодирования; в coordinator есть ветка версий для воспроизведения EAGLE', kind: 'термин', weight: 100, tags: ['спекулятивное декодирование'] },
  ],
  'PD-разделение': [
    { text: 'disaggregated prefill: prefill и decode разнесены по разным инстансам/узлам; в основном сценарии GLM на одной машине не проверено', kind: 'термин', weight: 100, tags: ['развёртывание'] },
  ],
  'disaggregated prefill': [
    { text: 'PD-разделение: архитектура с раздельным развёртыванием предзаполнения и декодирования', kind: 'термин', weight: 100, tags: ['развёртывание'] },
  ],
  'инференс': [
    { text: 'inference: вычисление ответа с фиксированными весами; скачивание, загрузка и инференс — три разные стадии', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'обучение': [
    { text: 'training: обновление весов по функции потерь и обратным распространением, противоположность инференсу', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],

  // ===== Дополнение: имена собственные и аббревиатуры из «GLM5.3-Flash: введение и разбор исходников» =====

  // —— Общие аббревиатуры и протоколы ——
  CPU: [
    { text: 'центральный процессор: host-описания (например, разбиение KDA на чанки) хранят копию на CPU; обработка пикселей обычно начинается с CPU', kind: 'аббр.', weight: 100, tags: ['железо'] },
  ],
  CLI: [
    { text: 'Command-Line Interface (интерфейс командной строки): точка чтения аргументов vllm serve', kind: 'аббр.', weight: 100, tags: ['фреймворк'] },
  ],
  HTTP: [
    { text: 'Hypertext Transfer Protocol (протокол передачи гипертекста): сетевой транспорт между клиентом и API-сервисом', kind: 'аббр.', weight: 100, tags: ['протокол'] },
  ],
  SSE: [
    { text: 'Server-Sent Events (события, отправляемые сервером): формат push-потока для потоковых ответов чата', kind: 'аббр.', weight: 100, tags: ['протокол'] },
  ],
  JSON: [
    { text: 'JavaScript Object Notation: формат данных запросов/ответов API; при приёмке проверяйте валидный JSON и наличие choices', kind: 'аббр.', weight: 100, tags: ['протокол'] },
  ],
  URL: [
    { text: 'унифицированный указатель ресурса: при сбое ввода изображения/видео сначала проверьте доступность URL', kind: 'аббр.', weight: 100, tags: ['протокол'] },
  ],
  UT: [
    { text: 'Unit Test (юнит-тест): прохождение одного mock UT не заменяет проверку точности ядра на NPU, длинного текста и высокой конкурентности', kind: 'аббр.', weight: 100, tags: ['тест'] },
  ],
  NaN: [
    { text: 'Not a Number (не число): недопустимое значение; NaN×0 остаётся NaN, поэтому состояние нового запроса обнуляют через torch.where, а не умножением на 0; с Inf так же', kind: 'термин', weight: 100, tags: ['числа'] },
  ],

  // —— Модели и железо из руководства ——
  GLM: [
    { text: 'серия General Language Model от Zhipu; похожие названия не означают взаимозаменяемость конфигураций', kind: 'аббр.', weight: 100, tags: ['модель'] },
  ],
  'GLM-5.3': [
    { text: 'другая модель серии GLM; в матрице поддержки это отдельная строка от GLM-5.3-Flash, выводы о механизмах и железе не наследуются', kind: 'модель', weight: 100, tags: ['модель'] },
  ],
  'GLM-5.2': [
    { text: 'предыдущая модель GLM; её стартовый скрипт W4A4C8 и переключатель разреженного KV C8 не применимы к GLM-5.3-Flash', kind: 'модель', weight: 100, tags: ['модель'] },
  ],
  'GLM-4.7-Flash': [
    { text: 'предыдущая Flash-модель GLM; источник имени tool-call-parser glm47, но это не значит, что данная модель — GLM4.7', kind: 'модель', weight: 100, tags: ['модель'] },
  ],
  'GLM-4.1V': [
    { text: 'исходная мультимодальная модель; класс-обёртка GLM-5.3-Flash наследует разбор/объединение визуального входа от её реализации glm4_1v', kind: 'модель', weight: 100, tags: ['модель'] },
  ],
  A2: [
    { text: 'поколение железа Ascend: в руководстве два узла 64GB×16, DP2×TP8, квантизация W8A8', kind: 'модель', weight: 100, tags: ['железо'] },
  ],
  A3: [
    { text: 'поколение железа Ascend: в руководстве TP16 и пример CANN 9.1.0; число карт в документации расходится — проверяйте npu-smi на месте', kind: 'модель', weight: 100, tags: ['железо'] },
  ],
  A5: [
    { text: 'поколение железа Ascend (серия 950): профиль FP8_OPTIMIZED использует sparse_flash_mla и требует согласованного CANN 9.2', kind: 'модель', weight: 100, tags: ['железо'] },
  ],
  Ascend: [
    { text: 'Ascend: платформа ИИ-вычислений Huawei, включающая железо NPU и программный стек CANN', kind: 'имя собств.', weight: 100, tags: ['железо'] },
  ],
  'Ascend (термин)': [
    { text: 'китайское название Ascend; гетерогенная вычислительная архитектура Ascend — это CANN', kind: 'имя собств.', weight: 100, tags: ['железо'] },
  ],
  CUDA: [
    { text: 'GPU-платформа NVIDIA; на Ascend поле графа по-прежнему зовётся cudagraph_mode, что не значит работу на CUDA', kind: 'имя собств.', weight: 100, tags: ['железо'] },
  ],
  PyTorch: [
    { text: 'открытый фреймворк глубокого обучения: связывает модули, тензоры и метаданные, а NPU использует через torch_npu', kind: 'имя собств.', weight: 100, tags: ['фреймворк'] },
  ],
  openEuler: [
    { text: 'открытый дистрибутив Linux; специальный образ для руководства по 950 основан на openEuler и отличается от общего образа Ubuntu', kind: 'имя собств.', weight: 100, tags: ['система'] },
  ],
  Ubuntu: [
    { text: 'распространённый дистрибутив Linux; общий Dockerfile использует базовый образ Ubuntu для 910B, это не перечень образов 950', kind: 'имя собств.', weight: 100, tags: ['система'] },
  ],
  Dockerfile: [
    { text: 'скрипт сборки образа контейнера; CANN 9.1.0 из общего Dockerfile нельзя автоматически перенести на 950', kind: 'термин', weight: 100, tags: ['развёртывание'] },
  ],
  'образ': [
    { text: 'образ контейнера: упаковывает среду выполнения; версии внутри образа из руководства нужно фиксировать на месте и сохранять digest для воспроизводимости', kind: 'термин', weight: 100, tags: ['развёртывание'] },
  ],
  digest: [
    { text: 'дайджест образа: хеш содержимого образа контейнера; при разборе проблем сохраняйте его вместе с командой запуска', kind: 'термин', weight: 100, tags: ['развёртывание'] },
  ],

  // —— Роли и компоненты фреймворка ——
  worker: [
    { text: 'рабочий процесс: владеет ресурсами устройства и выполняет загрузку модели и инференс', kind: 'термин', weight: 100, tags: ['фреймворк'] },
  ],
  executor: [
    { text: 'executor: компонент движка vLLM, управляющий worker', kind: 'термин', weight: 100, tags: ['фреймворк'] },
  ],
  rank: [
    { text: 'номер процесса в распределённой системе: при зависании коммуникаций смотрите rank, отказавший первым; дублирование rank узла может подвешивать обмен', kind: 'термин', weight: 100, tags: ['параллелизм'] },
  ],
  'entry points': [
    { text: 'точки входа Python-пакета: через них обнаруживаются платформенный и general-плагины vllm-ascend', kind: 'термин', weight: 100, tags: ['фреймворк'] },
  ],
  patch: [
    { text: 'патч: слой правок поверх upstream-кода, например регистрация конфигураций, распознавание MLA, патчи совместимости кэша', kind: 'термин', weight: 100, tags: ['фреймворк'] },
    { text: 'патч изображения: небольшой фрагмент изображения; визуальная модель нарезает картинку на такие фрагменты, это единица входа визуального ствола', kind: 'термин', weight: 50, tags: ['мультимодальность'] },
  ],
  Decoder: [
    { text: 'слой декодера: диспетчер слоя — внимание смешивает историю, MLP/MoE обрабатывает токен, остаточное соединение сохраняет исходное представление', kind: 'термин', weight: 100, tags: ['архитектура'] },
  ],
  'LM head': [
    { text: 'выходная голова: проецирует финальное скрытое состояние [T,H] в словарь; ParallelLMHead делит словарь на параллельные части', kind: 'термин', weight: 100, tags: ['архитектура'] },
  ],
  LogitsProcessor: [
    { text: 'обработчик logits: управляет параллельным выходом и масштабированием, стоит после LM head и до сэмплирования', kind: 'идентификатор', weight: 100, tags: ['фреймворк'] },
  ],
  proposer: [
    { text: 'proposer: компонент, итеративно вызывающий черновой слой для кандидатов при спекулятивном декодировании; draft в GLM принудительно eager', kind: 'термин', weight: 100, tags: ['спекулятивное декодирование'] },
  ],
  Mamba: [
    { text: 'семейство моделей пространства состояний; vLLM использует это имя для кэша линейного внимания (MambaSpec, mamba cache), состояния KDA идут через эту группировку', kind: 'имя собств.', weight: 100, tags: ['кэш'] },
  ],
  checkpoint: [
    { text: 'снимок весов: файл параметров модели, сохранённый при обучении', kind: 'термин', weight: 100, tags: ['веса'] },
    { text: 'контрольная точка кэша: точка выравнивания состояний в сценариях Mamba/prefix; для переиспользования префикса нужно совпадение', kind: 'термин', weight: 50, tags: ['кэш'] },
  ],

  // —— Механизмы и термины из руководства ——
  attention: [
    { text: 'внимание: механизм взвешенного чтения V по релевантности Q/K; GLM сочетает линейное внимание KDA и разреженное MLA', kind: 'термин', weight: 100, tags: ['внимание'] },
  ],
  'внимание': [
    { text: 'то же, что attention; в разреженных слоях этой модели индексный слой сначала выбирает позиции, затем читается основной кэш', kind: 'термин', weight: 100, tags: ['внимание'] },
  ],
  QKV: [
    { text: 'Q (Query) — что ищут, K (Key) — по чему сопоставляют, V (Value) — какую информацию извлекают', kind: 'аббр.', weight: 100, tags: ['внимание'] },
  ],
  'индексный слой': [
    { text: 'indexer: отвечает только на вопрос «какие позиции стоит читать» и не заменяет агрегацию значений основного MLA', kind: 'термин', weight: 100, tags: ['внимание'] },
  ],
  indexer: [
    { text: 'индексный слой: модуль выбора позиций разреженного внимания с проекциями query/key/gate', kind: 'термин', weight: 100, tags: ['внимание'] },
  ],
  GDN: [
    { text: 'названия из семейства Gated Delta Net: планировщик KDA использует GDNAttentionMetadata, чтобы различать спекулятивную проверку и обычные токены', kind: 'аббр.', weight: 100, tags: ['KDA'] },
  ],
  'остаточное соединение': [
    { text: 'residual: аддитивный канал, сохраняющий исходное представление между слоями; mHC расширяет его до нескольких остаточных потоков [T,n,H]', kind: 'термин', weight: 100, tags: ['архитектура'] },
  ],
  'гейт': [
    { text: 'gate: поэлементная модуляция сигнала; в KDA есть forget/output gate, в MLP — проекции gate/up', kind: 'термин', weight: 100, tags: ['архитектура'] },
  ],
  gate: [
    { text: 'гейт; в KPool gate также участвует во взвешивании ключей внутри пула и кэшируется вместе с индексным K', kind: 'термин', weight: 100, tags: ['архитектура'] },
  ],
  Sinkhorn: [
    { text: 'итерации Sinkhorn: алгоритм ограничения матрицы смешивания comb в mHC, число итераций задаёт mhc_sinkhorn_iterations', kind: 'термин', weight: 100, tags: ['архитектура'] },
  ],
  'grouped matmul': [
    { text: 'групповое матричное умножение: форма оператора для пакетных вычислений многих экспертов MoE; используется схемой MXFP8 MoE', kind: 'термин', weight: 100, tags: ['оператор'] },
  ],
  'patch embedding': [
    { text: 'эмбеддинг патчей: визуальный ствол GLM через Conv3d превращает патчи в векторы [P,Dv]', kind: 'термин', weight: 100, tags: ['мультимодальность'] },
  ],
  'даунсэмплинг': [
    { text: 'downsample: шаг сжатия с понижением разрешения; визуальный ствол через Conv2d и PatchMerger выдаёт [P/m²,H]', kind: 'термин', weight: 100, tags: ['мультимодальность'] },
  ],
  'шаблон чата': [
    { text: 'chat template: рендерит сообщения диалога в текст модели со спецметками ролей', kind: 'термин', weight: 100, tags: ['основы инференса'] },
  ],
  'causal mask': [
    { text: 'причинная маска: запрещает токену смотреть на будущие позиции; NoPE не отменяет причинную маску', kind: 'термин', weight: 100, tags: ['внимание'] },
  ],
  'причинная маска': [
    { text: 'то же, что causal mask: базовое ограничение авторегрессионной генерации', kind: 'термин', weight: 100, tags: ['внимание'] },
  ],
  padding: [
    { text: 'padding: недействительные позиции для выравнивания батча/размера графа; их состояние нужно сохранять, чтобы padding в режиме графа не портил результат', kind: 'термин', weight: 100, tags: ['оператор'] },
  ],
  'прогрев': [
    { text: 'warmup: пробный прогон перед обслуживанием; прогрев режима графа делает capture, а при медленном первом токене сначала отличайте холодный старт от устойчивого режима', kind: 'термин', weight: 100, tags: ['режим исполнения'] },
  ],
  'приоритетное вытеснение': [
    { text: 'preemption: при нехватке ресурсов запрос временно вытесняется; tail-блок возвращается в BlockPool при завершении/вытеснении', kind: 'термин', weight: 100, tags: ['планировщик'] },
  ],
  'воспроизведение': [
    { text: 'replay: воспроизведение записанных вызовов устройства при графовом исполнении; в контексте MTP — восстановление состояния с границы принятия и продолжение', kind: 'термин', weight: 100, tags: ['режим исполнения'] },
  ],
  FULL_DECODE_ONLY: [
    { text: 'значение cudagraph_mode: полный граф записывается только для стадии decode; используется основной моделью руководства', kind: 'идентификатор', weight: 100, tags: ['режим исполнения'] },
  ],
  cudagraph_mode: [
    { text: 'поле конфигурации графового режима vLLM: историческое имя от CUDA, на Ascend фактически соответствует ACL Graph', kind: 'идентификатор', weight: 100, tags: ['режим исполнения'] },
  ],
  MC2: [
    { text: 'направление Ascend по слиянию Matmul с коммуникациями; что использует MoE — all-to-all или MC2 — решают железо и конфигурация runner', kind: 'аббр.', weight: 100, tags: ['коммуникации'] },
  ],
};
