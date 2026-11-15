/**
 * hover-glossary / plugin/client-panel.js
 *
 * Шаблон браузерного модуля клиентского плагина DSH; scripts/build-client.mjs
 * собирает из него профильный пакет lib/client.js. Контракт:
 *   window.__ModuleLoader__.load({ id, factory })
 *   внутри factory(require) разрешаются только имена пакетов и примитивы
 *   платформы, относительные пути не поддерживаются -> вся логика встроена.
 *
 * Полностью клиентский плагин: словарь встроен в браузерную сборку, host-половина
 * и RPC не нужны, сервисы сессии не используются; через inject объявляется только
 * клиентский сервис slots. Установка в профиль сохраняет плагин после перезапуска.
 *
 * Плейсхолдер "__INLINE_SOURCE__" заменяется встроенной копией src/.
 */

window.__ModuleLoader__.load({
  // id обязан совпадать с name в package.json
  id: 'hover-glossary',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');

    /* ============ начало встроенного блока (генерирует build-client.mjs) ============ */
    /*__INLINE_SOURCE__*/
    /* ============ конец встроенного блока ============ */

    /** Индекс словаря: всё на клиенте, запросы не покидают браузер */
    const INDEX = createLexicon(SEED_TABLE);

    /** Склонение счётчика значений по правилам русского языка */
    function countLabel(n) {
      const mod10 = n % 10;
      const mod100 = n % 100;
      if (mod10 === 1 && mod100 !== 11) return n + ' значение';
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return n + ' значения';
      return n + ' значений';
    }

    const CSS = [
      '.hg-tip{position:fixed;z-index:2147483000;max-width:min(380px,calc(100vw - 24px));pointer-events:none;box-sizing:border-box;',
      'padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);',
      'box-shadow:0 6px 24px rgba(0,0,0,.28);font-size:12px;line-height:1.6;}',
      '.hg-tip-head{display:flex;align-items:baseline;gap:6px;margin-bottom:2px;}',
      '.hg-tip-word{font-weight:600;}',
      '.hg-tip-tag{color:var(--dsw-alias-label-secondary);font-size:11px;}',
      '.hg-tip ol{margin:0;padding-left:18px;}',
      '.hg-tip li{margin:1px 0;}',
      '.hg-tip .hg-tip-kind{color:var(--dsw-alias-label-secondary);font-size:11px;margin-left:6px;}',
    ].join('');

    const hoverStore = {
      state: { visible: false, term: '', entries: [], x: 0, y: 0 },
      listeners: new Set(),
      publish(next) {
        this.state = next;
        for (const listener of this.listeners) listener(next);
      },
    };

    const BROWSER = (() => {
      const doc = typeof document === 'undefined' ? null : document;
      if (!doc || typeof doc.addEventListener !== 'function') return null;
      return { root: window, doc };
    })();

    /** Внутри интерактивных элементов и чужих подсказок не ищем */
    const INTERACTIVE = { button: 1, a: 1, input: 1, textarea: 1, select: 1, option: 1, summary: 1 };

    /** Символ в точке документа и текст, из которого он взят */
    function charAtPoint(x, y) {
      if (!BROWSER) return null;
      const doc = BROWSER.doc;
      const element = doc.elementFromPoint(x, y);
      if (!element) return null;

      let node = null;
      let offset = -1;
      if (typeof doc.caretRangeFromPoint === 'function') {
        const range = doc.caretRangeFromPoint(x, y);
        if (range && range.startContainer && range.startContainer.nodeType === 3) {
          node = range.startContainer;
          offset = range.startOffset;
        }
      }
      if (!node && typeof doc.caretPositionFromPoint === 'function') {
        const position = doc.caretPositionFromPoint(x, y);
        if (position && position.offsetNode && position.offsetNode.nodeType === 3) {
          node = position.offsetNode;
          offset = position.offset;
        }
      }
      if (!node || offset < 0) return null;

      const data = typeof node.data === 'string' ? node.data : '';
      if (data.length === 0) return null;

      // offset каретки может встать справа от видимого символа, поэтому
      // проверяем обе соседние позиции
      const candidates = [];
      if (offset > 0 && isWordChar(data[offset - 1])) candidates.push(offset - 1);
      if (offset < data.length && isWordChar(data[offset])) candidates.push(offset);
      for (const at of candidates) {
        // API каретки прилипает к ближайшему тексту даже на пустом месте,
        // поэтому проверяем, что указатель реально попал в прямоугольник глифа.
        const glyph = doc.createRange();
        glyph.setStart(node, at);
        glyph.setEnd(node, at + 1);
        if (Array.from(glyph.getClientRects()).some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) {
          return { text: data, at, element: node.parentElement || element };
        }
      }
      return null;
    }

    /** Поднимаемся по дереву от найденного элемента и решаем, можно ли искать */
    function classify(element) {
      if (!element) return { ok: false, reason: 'no-element', chain: [] };
      const chain = [];
      let current = element;
      let inConversation = false;
      while (current && current !== BROWSER.doc.body && current !== BROWSER.doc.documentElement) {
        const tag = typeof current.tagName === 'string' ? current.tagName.toLowerCase() : '?';
        let cls = '';
        try {
          cls = typeof current.className === 'string' ? current.className : '';
        } catch (error) {
          cls = '';
        }
        if (chain.length < 6) chain.push(tag + (cls ? '.' + cls.split(' ').filter(Boolean).slice(0, 2).join('.') : ''));
        if (INTERACTIVE[tag]) return { ok: false, reason: 'inside-' + tag, chain };
        if (current.getAttribute && current.getAttribute('contenteditable') === 'true') return { ok: false, reason: 'editable', chain };
        const kind = current.getAttribute && current.getAttribute('data-chat-flow-kind');
        if (kind === 'user' || kind === 'assistant-step' || kind === 'steering') inConversation = true;
        current = current.parentElement;
      }
      return { ok: inConversation, reason: inConversation ? 'conversation' : 'outside-conversation', chain };
    }

    /** Самопроверка при запуске */
    function selfCheck() {
      const trace = {};
      trace.index = 'слов: ' + INDEX.size + ', толкований: ' + INDEX.itemCount;
      trace.hasElementFromPoint = !!(BROWSER && BROWSER.doc.elementFromPoint);
      trace.hasCaretRangeFromPoint = !!(BROWSER && BROWSER.doc.caretRangeFromPoint);
      trace.hasCaretPositionFromPoint = !!(BROWSER && BROWSER.doc.caretPositionFromPoint);
      if (BROWSER) {
        const w = BROWSER.root.innerWidth || 0;
        const h = BROWSER.root.innerHeight || 0;
        const probe = charAtPoint(Math.round(w * 0.5), Math.round(h * 0.35));
        trace.probe = probe
          ? { ok: true, text: probe.text.slice(0, 24), at: probe.at, glyph: probe.text[probe.at] }
          : { ok: false };
        if (probe) {
          const verdict = classify(probe.element);
          trace.classify = { ok: verdict.ok, reason: verdict.reason, chain: verdict.chain.join(' < ') };
          const token = tokenAt(probe.text, probe.at);
          trace.token = token ? token.term : null;
          trace.inLexicon = token ? INDEX.has(normalize(token.term)) : false;
        }
      }
      if (typeof globalThis !== 'undefined') globalThis.__hoverGlossaryDiag__ = trace;
      console.log('[hover-glossary] самопроверка ' + JSON.stringify(trace));
      return trace;
    }

    function GlossaryTip() {
      const [state, setState] = React.useState(hoverStore.state);
      React.useEffect(() => {
        const listener = (next) => setState(next);
        hoverStore.listeners.add(listener);
        return () => hoverStore.listeners.delete(listener);
      }, []);
      if (!state.visible) return null;
      const width = BROWSER ? BROWSER.root.innerWidth : 1200;
      const height = BROWSER ? BROWSER.root.innerHeight : 800;
      const below = state.y < height / 2;
      const style = { left: Math.max(12, Math.min(state.x + 14, width - 392)) + 'px',
        top: below ? state.y + 18 + 'px' : undefined,
        bottom: below ? undefined : height - state.y + 12 + 'px',
        maxHeight: Math.max(40, (below ? height - state.y - 30 : state.y - 24)) + 'px', overflow: 'auto' };
      const head = React.createElement(
        'div',
        { className: 'hg-tip-head' },
        React.createElement('span', { className: 'hg-tip-word' }, state.term),
        React.createElement('span', { className: 'hg-tip-tag' }, countLabel(state.entries.length)),
      );
      const body = React.createElement(
        'ol',
        null,
        state.entries.map((entry, index) =>
          React.createElement(
            'li',
            { key: index },
            entry.text,
            entry.kind ? React.createElement('span', { className: 'hg-tip-kind' }, entry.kind) : null,
          ),
        ),
      );
      return React.createElement('div', { className: 'hg-tip', role: 'tooltip', style: style }, head, body);
    }

    function apply(ctx) {
      // Зависимости графа модулей описаны в package.json; зависимости сервисов
      // объявляет экспортируемый ниже inject.
      const slots = ctx.slots;

      slots.inject('shell.overlay', () =>
        slots.register({ name: 'shell.overlay', id: 'hover-glossary-tip', order: 200 }, () =>
          React.createElement(React.Fragment, null,
            React.createElement('style', { 'data-hover-glossary': '' }, CSS),
            React.createElement(GlossaryTip)),
        ),
      );

      if (!BROWSER) {
        console.error('в окружении нет document: словарю при наведении некого слушать');
        return;
      }

      selfCheck();

      let shown = '';
      let last = 0;

      const hide = () => {
        shown = '';
        if (hoverStore.state.visible) {
          hoverStore.publish({ visible: false, term: '', entries: [], x: 0, y: 0 });
        }
      };

      // Обычное замыкание-троттлинг, без внешних сервисов
      const onMove = (event) => {
        const now = Date.now();
        if (now - last < 50) return;
        last = now;

        const x = event.clientX;
        const y = event.clientY;
        const hit = charAtPoint(x, y);
        if (!hit) {
          hide();
          return;
        }
        const verdict = classify(hit.element);
        if (!verdict.ok) {
          hide();
          return;
        }
        const match = INDEX.lookupAt(hit.text, hit.at);
        const key = match.key;
        if (match.entries.length === 0) {
          hide();
          return;
        }
        if (key === shown) {
          hoverStore.publish({ ...hoverStore.state, visible: true, x, y });
          return;
        }
        shown = key;
        hoverStore.publish({ visible: true, term: match.term, entries: match.entries, x, y });
      };

      const onLeave = () => hide();

      BROWSER.doc.addEventListener('mousemove', onMove, { passive: true });
      BROWSER.doc.addEventListener('mouseleave', onLeave, { passive: true });
      BROWSER.doc.addEventListener('scroll', onLeave, true);
      BROWSER.root.addEventListener('blur', onLeave);
      ctx.effect(() => () => {
        BROWSER.doc.removeEventListener('mousemove', onMove);
        BROWSER.doc.removeEventListener('mouseleave', onLeave);
        BROWSER.doc.removeEventListener('scroll', onLeave, true);
        BROWSER.root.removeEventListener('blur', onLeave);
        if (typeof globalThis !== 'undefined') delete globalThis.__hoverGlossaryDiag__;
        hoverStore.publish({ visible: false, term: '', entries: [], x: 0, y: 0 });
      });
    }

    exports.apply = apply;
    // Разрешение Cordis на доступ к сервисам: это не тот же список, что
    // зависимости графа модулей в манифесте.
    exports.inject = ['slots'];
    return module.exports;
  },
});
