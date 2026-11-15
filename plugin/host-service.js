/**
 * hover-glossary / plugin/host-service.js
 *
 * Исходник host-половины Cordis: чистый JS-код функции (без import/require).
 * Плейсхолдер "__INLINE_SOURCE__" заменяется встроенной копией src/.
 *
 * Задачи:
 *   - держать на стороне Host авторитетный словарь (SEED_TABLE из src/seed-data.mjs)
 *   - отдавать Client JSON-запросы через harness.handle('glossary/resolve')
 *   - разрешать Client добавлять свои толкования (glossary/define): демонстрация
 *     расширяемости 1 -> N
 */

/* ============ начало встроенного блока (генерирует build-client.mjs) ============ */
/*__INLINE_SOURCE__*/
/* ============ конец встроенного блока ============ */

const INDEX = createLexicon(SEED_TABLE);

/** Обрезает толкование до минимального JSON из чистых строк, чтобы не отдавать Client внутренние объекты */
function project(entry) {
  return {
    index: entry.index,
    text: entry.text,
    kind: entry.kind,
    weight: entry.weight,
  };
}

function emptyAnswer(cursor) {
  return { ok: true, cursor, term: '', key: '', entries: [], empty: true };
}

return {
  apply(ctx) {
    if (typeof harness === 'undefined' || harness === null) {
      console.error('harness недоступен: словарь при наведении не предоставит RPC');
      return;
    }

    const dispose = harness.handle('glossary/resolve', (args) => {
      const payload = args && typeof args === 'object' ? args : {};
      const text = typeof payload.text === 'string' ? payload.text : '';
      const cursor = Number(payload.cursor) || 0;

      // Случай A: Client прислал само слово (наведение или клик по слову словаря)
      if (typeof payload.term === 'string' && payload.term.length > 0) {
        const entries = INDEX.lookup(payload.term);
        const hit = tokenAt(text, cursor);
        return {
          ok: true,
          cursor,
          term: payload.term,
          key: normalize(payload.term),
          start: hit ? hit.start : cursor,
          end: hit ? hit.end : cursor,
          entries: entries.map(project),
          empty: entries.length === 0,
        };
      }

      // Случай B: разбор по позиции курсора
      if (typeof text !== 'string' || text.length === 0) return emptyAnswer(cursor);
      const at = INDEX.lookupAt(text, cursor, { keepLeft: payload.keepLeft !== false });
      return {
        ok: true,
        cursor,
        term: at.term,
        key: at.key,
        start: at.start,
        end: at.end,
        entries: at.entries.map(project),
        empty: at.entries.length === 0,
      };
    });
    ctx.effect(() => dispose);

    const disposeDefine = harness.handle('glossary/define', (args) => {
      const payload = args && typeof args === 'object' ? args : {};
      const term = typeof payload.term === 'string' ? payload.term : '';
      const items = Array.isArray(payload.entries) ? payload.entries : [];
      if (term.length === 0 || items.length === 0) {
        return { ok: false, error: 'term и entries не могут быть пустыми' };
      }
      INDEX.add(term, items);
      return { ok: true, term, total: INDEX.lookup(term).length, words: INDEX.size, items: INDEX.itemCount };
    });
    ctx.effect(() => disposeDefine);

    console.log('[hover-glossary] словарь готов: слов ' + INDEX.size + ', толкований ' + INDEX.itemCount);
  },
};
