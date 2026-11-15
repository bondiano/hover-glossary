/**
 * hover-glossary / test/plugin-source.test.mjs
 *
 * Тест 8: тела функций динамического плагина — корректный обычный JS (без ESM).
 * Тест 9: host-половина динамической версии реально исполняется в песочнице
 *         и проверяет harness.handle('glossary/resolve').
 * Тесты 10/11: тело клиентского bundle, словарь и host-половина совпадают
 *         по каждому курсору.
 * Тест 12: на fake DOM проходит весь путь «наведение -> символ -> классификация
 *          -> поиск -> всплывающая подсказка».
 *
 * Запуск: node test/run.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { SEED_TABLE } from '../src/seed-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Устанавливаемый клиентский bundle (браузерный модуль) — объект тестов 10-12 */
function browserModuleSource() {
  return readFileSync(resolve(root, 'lib/client.js'), 'utf8');
}
const define = JSON.parse(readFileSync(resolve(root, 'plugin/cordis-define.json'), 'utf8'));

/** Запускает host-половину в песочнице и возвращает { call, logs } */
function bootHost() {
  const handlers = new Map();
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERR ' + a.join(' ')) },
    harness: {
      handle(method, handler) {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      },
    },
    ctx: { effect: () => () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const plugin = vm.runInContext(`(function(){${define.code.host}})()`, sandbox, { filename: 'host.js' });
  plugin.apply(sandbox.ctx);
  return {
    call: (method, args) => {
      const handler = handlers.get(method);
      assert.ok(handler, `RPC не зарегистрирован: ${method}`);
      return handler(args);
    },
    logs,
  };
}

const host = bootHost();
const SAMPLE = 'В United Nations есть WHO и ВОЗ, это всё в словаре';
const cursorOf = (needle, offset = 0) => SAMPLE.indexOf(needle) + offset;
/** Объекты из песочницы принадлежат другому realm, поэтому сравниваем через JSON */
const j = (value) => JSON.stringify(value);

/** Минимальная заглушка React: только три используемых API */
const reactStub = {
  createElement: () => ({}),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
};

/**
 * Выполняет client bundle с семантикой браузерного модуля и забирает
 * factory вместе с объектом плагина.
 * Исходник обёрнут в `window.__ModuleLoader__.load({ id, factory })` —
 * это контракт локального пакета плагина.
 * @param {string} source - содержимое plugin/package/lib/client.js
 */
function loadClientModule(source) {
  let captured = null;
  const sandbox = { console: { log() {}, error() {} } };
  sandbox.window = sandbox;
  sandbox.__ModuleLoader__ = { load: (definition) => { captured = definition; } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client-module.js' });
  assert.ok(captured, 'client bundle не зарегистрировался в __ModuleLoader__');
  const plugin = captured.factory((name) => {
    if (name === 'react') return reactStub;
    throw new Error('недопустимый require: ' + name);
  });
  return { definition: captured, plugin, sandbox };
}

/**
 * Достаёт внутренние INDEX и функцию определения слова под курсором из
 * клиентского контекста.
 * Приём: в контексте модуля объявляем глобальный зонд, и замыкание factory
 * выкладывает в него внутренний индекс.
 * @param {string} source
 */
function makeClientSandbox(source) {
  const probe = `
    globalThis.__index__ = INDEX;
    globalThis.__termAt__ = (text, cursor) => {
      const hit = tokenAt(text, cursor);
      return hit ? hit.term : null;
    };
    globalThis.__tokenAt__ = (text, cursor) => tokenAt(text, cursor);
  `;
  const marker = '\n    function apply(ctx) {';
  const at = source.indexOf(marker);
  assert.ok(at > 0, 'в исходнике клиента должна быть функция apply');
  const patched = source.slice(0, at) + '\n' + probe + source.slice(at);
  return loadClientModule(patched).sandbox;
}

test('тест8: оба тела функций — корректный исходник без ESM-синтаксиса', () => {
  for (const half of ['host', 'client']) {
    const source = define.code[half];
    assert.ok(source.length > 1000, `${half}: исходник слишком короткий`);
    assert.ok(!/^\s*import\s/m.test(source), `${half}: не должно быть import`);
    assert.ok(!/^\s*export\s/m.test(source), `${half}: не должно быть export`);
    assert.doesNotThrow(() => new Function(source), `${half}: проверка синтаксиса не прошла`);
  }
  // Host-половина динамической версии работает в замыкании Node, require ей
  // запрещён; клиентская половина — браузерный модуль и может требовать только
  // примитивы платформы (react)
  assert.ok(!/\brequire\s*\(/.test(define.code.host), 'в host-половине не должно быть require');
  const requires = [...define.code.client.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(requires)], ['react'], `client должен требовать только react, а требует: ${requires.join(', ')}`);
  assert.equal(define.name, 'Толковый словарь при наведении');
});

test('тест9: Host RPC по курсору возвращает 1..N толкований', () => {
  // 1) Пример из задачи: WHO -> 1) ВОЗ 2) кто
  const who = host.call('glossary/resolve', { text: SAMPLE, cursor: cursorOf('WHO', 1) });
  assert.equal(who.ok, true);
  assert.equal(who.key, 'who');
  assert.equal(j(who.entries.map((e) => e.text)), j(['ВОЗ', 'кто']));
  assert.equal(j(who.entries.map((e) => e.index)), j([1, 2]));
  // Возвращаемый объект должен быть минимальным и сериализуемым в JSON
  assert.deepEqual(Object.keys(who.entries[0]).sort(), ['index', 'kind', 'text', 'weight']);
  assert.doesNotThrow(() => JSON.stringify(who));

  // 2) Длинное словосочетание: курсор в первом слове
  const long = host.call('glossary/resolve', { text: SAMPLE, cursor: cursorOf('United Nations', 3) });
  assert.equal(long.term, 'United Nations');
  assert.equal(long.entries[0].text, 'Организация Объединённых Наций (ООН)');

  // 3) Фраза через пробел: курсор в любом месте первого слова находит всю фразу
  for (const offset of [0, 3, 6]) {
    const un = host.call('glossary/resolve', { text: SAMPLE, cursor: cursorOf('United Nations', offset) });
    assert.equal(un.term, 'United Nations', `offset ${offset} должен находить всю фразу`);
    assert.equal(un.entries.length, 2);
  }
  // Курсор на втором слове ищет только это слово, без растягивания влево
  assert.equal(host.call('glossary/resolve', { text: SAMPLE, cursor: cursorOf('United Nations', 9) }).entries.length, 0);

  // 4) Клиент запрашивает прямо по слову (ветка наведения на слово словаря)
  const pinned = host.call('glossary/resolve', { text: SAMPLE, cursor: 0, term: 'api' });
  assert.equal(pinned.key, 'api');
  assert.equal(pinned.entries.length, 3);

  // 5) Не найдено / пустой ввод: ok и пустой массив, без исключения
  const none = host.call('glossary/resolve', { text: 'такого слова нет', cursor: 0 });
  assert.equal(none.ok, true);
  assert.equal(j(none.entries), '[]');
  assert.equal(none.empty, true);
  const blank = host.call('glossary/resolve', { cursor: 999 });
  assert.equal(blank.ok, true);
  assert.equal(j(blank.entries), '[]');

  // 6) Толкования можно дополнять: N в 1 -> N растёт
  const added = host.call('glossary/define', { term: 'DSH-Test', entries: ['своё объяснение раз', 'своё объяснение два'] });
  assert.equal(added.ok, true);
  assert.equal(added.total, 2);
  const after = host.call('glossary/resolve', { term: 'dsh-test', cursor: 0, text: '' });
  assert.equal(j(after.entries.map((e) => e.text)), j(['своё объяснение раз', 'своё объяснение два']));
  // Неверные аргументы дают явную ошибку, а не тихий пропуск
  assert.equal(host.call('glossary/define', { term: '', entries: [] }).ok, false);

  assert.ok(host.logs.some((line) => line.includes('словарь готов')), 'host при старте должен сообщать размер словаря');
});

test('тест10: клиентский исходник украшает только реальный текст, без демонстрационных панелей', () => {
  const source = define.code.client;

  // Панель должна содержать встроенные SEED_TABLE / текст, чтобы работать автономно
  assert.ok(/const SEED_TABLE\s*=/.test(source), 'клиент должен встраивать SEED_TABLE');
  for (const term of Object.keys(SEED_TABLE)) {
    assert.ok(source.includes(term), `во встроенном словаре клиента нет «${term}»`);
  }

  // Демонстрационной панели быть не должно
  assert.ok(!/const CELLS\s*=/.test(source), 'старая логика демонстрационной панели должна быть удалена');
  assert.ok(!/hg-panel/.test(source), 'демонстрационная панель не должна регистрироваться');
  assert.ok(!/simulate|симуляц/i.test(source), 'не должно быть симуляции курсора');

  // Обязательные части движка: символ под курсором + подсказка + самопроверка
  assert.ok(/caretRangeFromPoint|caretPositionFromPoint/.test(source), 'нет определения символа под курсором');
  assert.ok(/shell\.overlay/.test(source), 'подсказка должна регистрироваться в shell.overlay');
  assert.ok(/function selfCheck/.test(source), 'должна быть самопроверка при запуске');
  assert.ok(source.includes('__hoverGlossaryDiag__'), 'результат самопроверки должен быть доступен из консоли');
  assert.ok(!source.includes('data-hg-zone'), 'нельзя опираться на якорные элементы для определения области');
  assert.ok(!source.includes('conversation.chat.turnTail'), 'нельзя конкурировать с цепочкой turnTail');
  assert.ok(/addEventListener\('mousemove'/.test(source), 'должен быть подписан на движение мыши');
  assert.ok(!/\bdocument\.body\s*\.\s*(append|innerHTML|style)/.test(source), 'нельзя менять DOM продукта');

  // Встроенный в клиент словарь должен совпадать с host-половиной: на одном и
  // том же тексте результат по каждому курсору одинаков
  const sandbox = makeClientSandbox(source);
  const clientTermAt = (text, cursor) => sandbox.__termAt__(text, cursor);
  const clientEntries = (term) => sandbox.__index__.lookup(term);
  assert.equal(sandbox.__index__.size, Object.keys(SEED_TABLE).length);

  const realText = [
    'подскажи, что значит WHO',
    'WHO — это ВОЗ, полное название World Health Organization, она же Всемирная организация здравоохранения.',
  ];
  const seen = new Set();
  for (const text of realText) {
    for (let cursor = 0; cursor < text.length; cursor += 1) {
      const term = clientTermAt(text, cursor);
      if (!term) continue;
      const entries = clientEntries(term);
      if (entries.length === 0) continue;
      seen.add(term.toLowerCase());
      // Тот же курсор на стороне Host должен давать ровно те же толкования
      const hostResult = host.call('glossary/resolve', { text, cursor, term });
      assert.equal(
        j(hostResult.entries.map((e) => e.text)),
        j(entries.map((e) => e.text)),
        `на позиции ${cursor} (${term}) host и клиент расходятся`,
      );
    }
  }
  assert.ok(seen.has('who'), 'WHO из реального текста должно распознаваться клиентом');
  assert.ok(seen.has('воз'), 'сокращение ВОЗ из реального текста должно распознаваться');
  // Не входящие в словарь слова не дают подсказки
  assert.equal(clientEntries('фраза без словарных слов').length, 0);
});

test('тест11: на реальном тексте диалога host и клиент совпадают по каждому курсору', () => {
  const sandbox = makeClientSandbox(define.code.client);

  // Смешанный русско-английский текст диалога
  const transcript = [
    'Я спросил: объясни WHO и United Nations в двух словах',
    'Ответ: WHO — это ВОЗ; в DSH плагины расширяет Cordis, а API и LLM — разные вещи.',
    'Ещё: токен и токенизатор — не одно и то же, а скрытое состояние — не ответ модели.',
  ].join('\n');

  let hits = 0;
  for (let cursor = 0; cursor < transcript.length; cursor += 1) {
    const term = sandbox.__termAt__(transcript, cursor);
    if (!term) continue;
    const entries = sandbox.__index__.lookup(term);
    if (entries.length === 0) continue;
    hits += 1;
    const hostResult = host.call('glossary/resolve', { text: transcript, cursor, term });
    assert.ok(hostResult.entries.length >= 1, `на позиции ${cursor} host ничего не нашёл`);
    assert.equal(
      j(hostResult.entries.map((e) => e.text)),
      j(entries.map((e) => e.text)),
      `на позиции ${cursor} (${term}) host и клиент расходятся`,
    );
  }
  assert.ok(hits >= 10, `в реальном тексте слишком мало попаданий (${hits})`);
  // Слова вне словаря не дают подсказки
  assert.equal(sandbox.__index__.lookup('фраза без словарных слов').length, 0);
});

/**
 * Загружает client bundle с семантикой браузерного модуля, применяет плагин и
 * имитирует одно движение мыши на fake DOM.
 * Это единственный тест, покрывающий весь путь «мышь -> символ -> классификация
 * -> поиск -> отрисовка подсказки»; именно здесь раньше ломалось «наведение не
 * реагирует».
 *
 * Постоянная версия полностью клиентская: поиск идёт в браузере, RPC нет,
 * поэтому проверяется реальный результат отрисовки (текст и толкования),
 * а не «был ли запрос».
 */
function runHoverOnce(options) {
  const listeners = { mousemove: [], mouseleave: [], scroll: [], blur: [] };
  if (options.element && !options.outside) {
    options.element.parentElement = { getAttribute: name => name === 'data-chat-flow-kind' ? 'user' : null };
  }
  const doc = {
    addEventListener(type, fn) {
      if (listeners[type]) listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    elementFromPoint: () => options.element,
    caretRangeFromPoint: () => ({ startContainer: options.node, startOffset: options.offset }),
    createRange: () => ({setStart() {}, setEnd() {}, getClientRects: () => options.blank ? [] : [{left: 90,right: 110,top:90,bottom:110}]}),
    body: {},
    documentElement: {},
  };
  const logs = [];
  const elements = [];
  const registered = [];
  const slots = {
    inject: (key, callback) => {
      try {
        const maybe = callback();
        if (typeof maybe === 'function') maybe();
      } catch (error) {
        logs.push('ERR inject ' + key + ': ' + error.message);
      }
      return () => {};
    },
    register: (definition, render) => {
      // Объект регистрации имеет вид { name, render } — рендер лежит в .render
      assert.equal(typeof render, 'function', 'slots.register должен получить функцию рендера: ' + JSON.stringify(definition));
      registered.push(render);
      return () => {};
    },
  };

  // Заглушка React, близкая к настоящему: useState вызывает перерисовку,
  // useEffect учитывает массив зависимостей, рендер не переиспользует сам себя
  // (иначе setState -> flush -> render зацикливается).
  // Ячейка хука адресуется парой «идентификатор компонента + номер хука»:
  // ориентироваться на глубину вложенности нельзя, иначе два верхних
  // компонента (GlossaryTip и DiagCard) делили бы одну ячейку.
  const hookState = new Map();
  const effectCells = new Map();
  let currentComponent = -1; // текущий компонент, -1 — вне компонента
  let hookCursor = 0;
  let renderDepth = 0;
  let nextComponentId = 1;
  const renderers = [];
  const pendingCleanups = [];
  const React = {
    // React вызывает функциональные компоненты при отрисовке, заглушка обязана
    // делать то же, иначе внутренние элементы компонента не видны
    createElement: (type, props, ...children) => {
      if (typeof type === 'function') {
        const id = type.__hgId || (type.__hgId = nextComponentId++);
        const savedComponent = currentComponent;
        const savedCursor = hookCursor;
        currentComponent = id;
        hookCursor = 0;
        try {
          return type({ ...(props || {}), children });
        } finally {
          currentComponent = savedComponent;
          hookCursor = savedCursor;
        }
      }
      const element = { type, props, children };
      elements.push(element);
      return element;
    },
    useState: (initial) => {
      const key = currentComponent + ':' + hookCursor;
      hookCursor += 1;
      if (!hookState.has(key)) hookState.set(key, initial);
      const setter = (value) => {
        const previous = hookState.get(key);
        hookState.set(key, typeof value === 'function' ? value(previous) : value);
        flush();
      };
      return [hookState.get(key), setter];
    },
    useEffect: (effect, deps) => {
      const key = currentComponent + ':' + hookCursor;
      hookCursor += 1;
      const previous = effectCells.get(key);
      const sameDeps =
        previous &&
        Array.isArray(deps) &&
        Array.isArray(previous.deps) &&
        deps.length === previous.deps.length &&
        deps.every((value, index) => Object.is(value, previous.deps[index]));
      if (sameDeps) return;
      // Во время рендера только регистрируем; побочные эффекты выполняет
      // фаза коммита в flush
      effectCells.set(key, { deps: deps ? deps.slice() : null, effect });
    },
  };

  // У каждого компонента своя область хуков, поэтому курсор сбрасывается
  // перед отрисовкой каждого компонента
  function flush() {
    if (renderDepth > 0) return;
    renderDepth += 1;
    try {
      for (let pass = 0; pass < 4; pass += 1) {
        elements.length = 0;
        currentComponent = -1;
        for (const render of renderers) {
          hookCursor = 0;
          render();
        }
      }
      // Фаза коммита: выполняем эффекты, изменившиеся в этом проходе (как React)
      for (const cell of effectCells.values()) {
        if (cell.ran === cell.deps) continue;
        cell.ran = cell.deps;
        const cleanup = cell.effect();
        if (typeof cleanup === 'function') pendingCleanups.push(cleanup);
      }
    } finally {
      renderDepth -= 1;
    }
  }

  let captured = null;
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERR ' + a.join(' ')) },
    document: doc,
    navigator: { userAgent: 'fake' },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type, fn) => listeners[type]?.push(fn),
    removeEventListener: (type, fn) => { if (listeners[type]) listeners[type] = listeners[type].filter(f=>f!==fn); },
    Date,
    setTimeout,
    clearTimeout,
    __ModuleLoader__: { load: (definition) => { captured = definition; } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(browserModuleSource(), sandbox, { filename: 'client-run.js' });

  assert.ok(captured, 'client bundle не зарегистрировался в __ModuleLoader__');
  const plugin = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error('недопустимый require: ' + name);
  });
  if (options.inject) plugin.inject = options.inject;

  // Регистрация только складывает функции рендера, применяются они после
  // apply. В ctx доступен только ctx.slots (как в реальном рантайме), а
  // ctx.get('slots') намеренно не даётся: так «тихое» отсутствие зависимости
  // сразу видно в тесте.
  plugin.apply({
    get slots() {
      assert.ok(plugin.inject.includes('slots'), 'cannot get property "slots" without inject');
      return slots;
    },
    effect: (effect) => {
      const cleanup = effect();
      if (typeof cleanup === 'function') pendingCleanups.push(cleanup);
      return () => {};
    },
  });
  for (const render of registered) renderers.push(render);
  flush();

  assert.ok(listeners.mousemove.length >= 1, 'должен быть зарегистрирован слушатель mousemove');
  // Троттлинг 50 мс, поэтому движение мыши вызывается один раз; изменение
  // состояния вызывает перерисовку через setter
  for (const fn of listeners.mousemove) fn({ clientX: 100, clientY: 100 });

  return {
    elements,
    listeners,
    logs,
    cleanup() {
      for (const fn of pendingCleanups) fn();
    },
  };
}

/** Собирает текст из дерева элементов React */
function collectText(node, out) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === 'object' && node.children) collectText(node.children, out);
  return out;
}

/** Точное вхождение класса className в props (чтобы hg-diag-head не считался hg-diag) */
function hasClass(element, name) {
  if (!element || !element.props || typeof element.props.className !== 'string') return false;
  return element.props.className.split(/\s+/).includes(name);
}

/** Текст, отрисованный сейчас в подсказке (hg-tip) */
function tipText(run) {
  const tip = run.elements.filter((element) => hasClass(element, 'hg-tip')).pop();
  if (!tip) return null;
  return collectText(tip, []).join(' ');
}

/** Текст диагностической карточки (hg-diag) */
function diagText(run) {
  const card = run.elements.filter((element) => hasClass(element, 'hg-diag')).pop();
  if (!card) return null;
  return collectText(card, []).join(' ');
}

test('тест12: наведение на слово в тексте рисует всплывающую подсказку (весь путь)', () => {
  // Позиции: u0 s1 e2 ␣3 W4 H5 O6 ␣7 h8 e9 r10 e11
  const node = { nodeType: 3, data: 'use WHO here' };

  // Каретка попадает справа от видимого символа (offset 7 — пробел после WHO):
  // нужно сдвинуться на одну позицию влево, к O
  const rightSide = runHoverOnce({ element: { tagName: 'SPAN' }, node, offset: 7 });
  const tip1 = tipText(rightSide);
  assert.ok(tip1, 'наведение на WHO должно рисовать подсказку');
  assert.ok(tip1.includes('WHO'), `подсказка должна показывать само слово, а показывает: ${tip1}`);
  assert.ok(tip1.includes('ВОЗ'), `подсказка должна показывать толкование WHO, а показывает: ${tip1}`);
  assert.ok(tip1.includes('кто'), `подсказка должна показывать все 1..N толкований, а показывает: ${tip1}`);

  // offset ровно между H и O
  const onChar = runHoverOnce({ element: { tagName: 'SPAN' }, node, offset: 6 });
  assert.ok((tipText(onChar) || '').includes('ВОЗ'), 'offset внутри слова тоже должен находить слово');

  // offset на первой букве W
  const onFirst = runHoverOnce({ element: { tagName: 'SPAN' }, node, offset: 4 });
  assert.ok((tipText(onFirst) || '').includes('ВОЗ'), 'offset на первой букве должен находить слово');

  // Слово вне словаря: подсказки нет
  const none = runHoverOnce({ element: { tagName: 'SPAN' }, node, offset: 9 });
  assert.equal(tipText(none), null, 'слово вне словаря не должно давать подсказку');

  // Курсор внутри элемента управления: подсказки нет
  const insideButton = runHoverOnce({
    element: { tagName: 'BUTTON', parentElement: null },
    node,
    offset: 6,
  });
  assert.equal(tipText(insideButton), null, 'внутри элементов управления подсказки быть не должно');

  // Получение символа вернуло null: исключения быть не должно
  const blank = runHoverOnce({ element: null, node, offset: 6 });
  assert.equal(tipText(blank), null);
  assert.ok(!blank.logs.some((line) => line.startsWith('ERR')), `исключений быть не должно: ${blank.logs.join(' | ')}`);

  assert.equal(diagText(rightSide), null, 'лишнего диагностического интерфейса быть не должно');
  for (const run of [rightSide,onChar,onFirst,none,insideButton,blank]) run.cleanup();
});

test('тест14: без объявленной зависимости сервис недоступен, а глобального styles нет', () => {
  assert.throws(() => runHoverOnce({element: {tagName:'SPAN'}, node:{nodeType:3,data:'WHO'},offset:1,inject:[]}), /without inject/);
  const run=runHoverOnce({element:{tagName:'SPAN'},node:{nodeType:3,data:'WHO'},offset:1});
  assert.ok(tipText(run).includes('ВОЗ'));
  assert.ok(run.elements.some(e=>e.type==='style'), 'стили должны управляться через React');
  run.cleanup();
  assert.ok(Object.values(run.listeners).every(v=>v.length===0), 'при выгрузке снимаются все слушатели');
});

test('тест15: пять слов, кириллица и словосочетания проходят реальный путь mousemove', () => {
  for(const [text, offset, expected] of [
    ['WHO',1,'ВОЗ'],['API',1,'интерфейс прикладного программирования'],['DSH',1,'DeepSeek Harness'],
    ['Cordis',2,'среда выполнения плагинов'],['LLM',1,'языковая модель'],
    ['Всемирная организация здравоохранения',4,'сокращённо ВОЗ'],['United Nations',3,'Организация Объединённых Наций'],
    ['токенизатор',2,'tokenizer']
  ]) {
    const run=runHoverOnce({element:{tagName:'SPAN'},node:{nodeType:3,data:text},offset});
    assert.ok((tipText(run)||'').includes(expected),text+' должен находить '+expected);
    run.cleanup();
  }
});

test('тест16: боковая панель и пустое место не срабатывают, прокрутка закрывает подсказку', () => {
  for(const extra of [{outside:true},{blank:true}]) {
    const run=runHoverOnce({element:{tagName:'SPAN'},node:{nodeType:3,data:'WHO'},offset:1,...extra});
    assert.equal(tipText(run),null);
    run.cleanup();
  }
  // Кириллическая граница слова: «токен» не должен срабатывать внутри «псевдотокен»
  const suffix = runHoverOnce({element:{tagName:'SPAN'},node:{nodeType:3,data:'псевдотокен'},offset:7});
  assert.equal(tipText(suffix),null,'слово внутри более длинного не должно давать подсказку');
  suffix.cleanup();
  const run=runHoverOnce({element:{tagName:'SPAN'},node:{nodeType:3,data:'WHO'},offset:1});
  assert.ok(tipText(run));
  run.listeners.scroll.forEach(fn=>fn());
  assert.equal(tipText(run),null);
  run.cleanup();
});
