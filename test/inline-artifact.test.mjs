/**
 * hover-glossary / test/inline-artifact.test.mjs
 *
 * Тест 6: встроенная клиентская копия совпадает с src/.
 *
 * Клиентская половина не может использовать import, поэтому реализация из
 * src/lexicon.mjs встраивается в сборку. Тест выполняет встроенную копию в
 * песочнице vm и сравнивает её результаты с src/, чтобы
 * plugin/client-inline.js не устаревал незаметно.
 *
 * Запуск: node test/run.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { createLexicon } from '../src/lexicon.mjs';
import { SEED_TABLE } from '../src/seed-data.mjs';
import { buildInlineSource, composeTemplate, buildPackageHostSource } from '../scripts/build-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** «Реальный текст» для теста 6: латиница, кириллица и словосочетания */
const SAMPLE_TEXT = [
  'Я спросил: объясни WHO и United Nations в двух словах',
  'Ответ: WHO — это ВОЗ, она же Всемирная организация здравоохранения; в DSH плагины расширяет Cordis.',
  'Ещё: чем API отличается от LLM и при чём тут DeepSeek',
].join('\n');

/** Выполняет встроенный исходник в песочнице и забирает его собственный Lexicon */
function loadInlineLexicon() {
  const source = readFileSync(resolve(root, 'plugin/client-inline.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nglobalThis.__inlineLexicon__ = createLexicon(SEED_TABLE);`, sandbox, {
    filename: 'client-inline.js',
  });
  return sandbox.__inlineLexicon__;
}

const inline = loadInlineLexicon();
const source = createLexicon(SEED_TABLE);

test('тест6: встроенная клиентская копия полностью совпадает с src/', () => {
  assert.equal(inline.size, source.size);
  assert.equal(inline.itemCount, source.itemCount);

  // Толкования сверяются сериализацией: массивы из песочницы принадлежат
  // другому realm, и deepEqual счёл бы их разными из-за прототипов.
  assert.equal(JSON.stringify(inline.list()), JSON.stringify(source.list()));

  // Поиск по курсору совпадает на каждой позиции реального текста
  const full = SAMPLE_TEXT;
  let checked = 0;
  for (let cursor = 0; cursor <= full.length; cursor += 1) {
    const a = inline.lookupAt(full, cursor);
    const b = source.lookupAt(full, cursor);
    assert.deepEqual(
      { term: a.term, key: a.key, start: a.start, end: a.end, n: a.entries.length },
      { term: b.term, key: b.key, start: b.start, end: b.end, n: b.entries.length },
      `на позиции ${cursor} две реализации расходятся`,
    );
    checked += 1;
  }
  assert.ok(checked > 100, 'должен быть проверен весь текст');
  assert.ok(source.lookupAt(full, full.indexOf('WHO')).entries.length === 2, 'текст должен разбираться');

  // Во встроенной копии не должно остаться ESM-синтаксиса, иначе клиентское
  // замыкание Cordis не распарсится
  const raw = readFileSync(resolve(root, 'plugin/client-inline.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(raw), 'во встроенной копии не должно быть import');
  assert.ok(!/^\s*export\s/m.test(raw), 'во встроенной копии не должно быть export');
  assert.ok(!/\brequire\s*\(/.test(raw), 'во встроенной копии не должно быть require');
});

test('тест7: артефакты совпадают с выводом сборщика (не устарели)', () => {
  const expected = buildInlineSource();
  const actual = readFileSync(resolve(root, 'plugin/client-inline.js'), 'utf8');
  assert.equal(actual, expected, 'plugin/client-inline.js устарел: запустите node scripts/build-client.mjs');

  // Оба артефакта должны происходить из одного встроенного исходника, иначе
  // динамическая и постоянная версии разойдутся
  const bundle = readFileSync(resolve(root, 'lib/client.js'), 'utf8');
  const defineJson = JSON.parse(readFileSync(resolve(root, 'plugin/cordis-define.json'), 'utf8'));
  assert.equal(defineJson.code.client, bundle, 'lib/client.js и cordis-define.json рассинхронизированы');
  assert.ok(bundle.includes(expected), 'профильный пакет не содержит встроенный словарь');
  assert.equal(bundle, composeTemplate('plugin/client-panel.js'), 'после правки шаблона клиента нужна пересборка');
  assert.equal(readFileSync(resolve(root, 'lib/index.js'), 'utf8'), buildPackageHostSource());
});

/**
 * Загружает client bundle профильного пакета с семантикой браузера:
 * подставляет window.__ModuleLoader__ и заглушку require, возвращает factory.
 */
function loadBrowserModule() {
  const bundle = readFileSync(resolve(root, 'lib/client.js'), 'utf8');
  let captured = null;
  const sandbox = { console: { log() {}, error() {} }, Date, setTimeout, clearTimeout, globalThis: undefined };
  sandbox.window = sandbox;
  sandbox.__ModuleLoader__ = {
    load(definition) {
      captured = definition;
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox, { filename: 'hover-glossary-client.js' });
  return { definition: captured, sandbox };
}

test('тест13: корень репозитория — корректный клиентский плагин-пакет (условие установки)', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  // Контракт: локальный пакет объявляет себя браузерным плагином через
  // dsh.client.platform, иначе загрузчик его не смонтирует
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.type, 'module');
  assert.ok(manifest.exports['./client'], 'должен экспортироваться ./client');

  // Контракт: dsh.bundle.patch указывает на существующий патч сборки, иначе
  // dsh plugin add добавит пакет как обычную зависимость и UI плагинов его
  // не покажет
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'должен быть объявлен dsh.bundle.patch');
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml', 'должен экспортироваться ./cordis.patch.yml');
  const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes(`name: '${manifest.name}'`), 'патч сборки должен монтировать пакет по его имени');

  // Русская локализация панели плагинов: экспортируемые locale-файлы
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json', 'должен экспортироваться ./locale/*.json');
  assert.ok(manifest.files.includes('locale'), 'locale должен попадать в пакет');
  const ru = JSON.parse(readFileSync(resolve(root, 'locale/ru.json'), 'utf8'));
  assert.equal(ru.meta.title, 'Толковый словарь при наведении');
  assert.ok(ru.meta.description.length > 20 && !/[\u4e00-\u9fff]/.test(ru.meta.description));

  // host-половина должна быть ESM, загружаемым Node, и экспортировать только apply
  const hostEntry = readFileSync(resolve(root, 'lib/index.js'), 'utf8');
  assert.ok(/export\s*\{\s*apply\s*\}/.test(hostEntry), 'host-половина должна экспортировать apply');
  assert.ok(!/^\s*import\s/m.test(hostEntry), 'host-половине не нужен import');

  // client bundle регистрируется по контракту загрузчика, id равен имени пакета
  const { definition } = loadBrowserModule();
  assert.ok(definition, 'bundle не вызвал __ModuleLoader__.load');
  assert.equal(definition.id, manifest.name, 'id должен совпадать с name из package.json');
  assert.equal(typeof definition.factory, 'function');

  // factory возвращает объект-плагин Cordis; чисто клиентский плагин всё равно
  // обязан объявить зависимость от клиентского сервиса
  const reactStub = {
    createElement: () => ({}),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  };
  const requireStub = (name) => {
    if (name === 'react') return reactStub;
    throw new Error('недопустимый require: ' + name);
  };
  const mod = definition.factory(requireStub);
  const plugin = mod && mod.default ? mod.default : mod;
  assert.equal(typeof plugin.apply, 'function', 'factory должен экспортировать apply');
  assert.equal(JSON.stringify(plugin.inject), '["slots"]', 'должна быть объявлена зависимость от сервиса slots');

  // Ключевой контракт: без объявления slots сервис ctx.slots не разрешается
  // и плагин молча не работает (именно так случилось в первом запуске).
  assert.equal(
    JSON.stringify(manifest.dsh.client.inject),
    JSON.stringify(['@deepseek-ai/dsh-client-ui-renderer']),
    'package.json должен объявлять внедрение slots, иначе словарь ничего не зарегистрирует',
  );

  const record = readFileSync(resolve(root, 'lib/client.js'), 'utf8');

  // Сервис берётся только через объявленный inject (ctx.slots); проверяем
  // строки кода без комментариев, чтобы пояснения не срабатывали как код
  const codeLines = record
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.ok(/ctx\.slots/.test(codeLines), 'сервис slots должен браться через ctx.slots');
  assert.ok(
    !/ctx\.get\(\s*['"]slots['"]\s*\)/.test(codeLines),
    'нельзя брать slots через ctx.get — он молча вернёт undefined',
  );

  // Встроенный словарь работает на клиенте сам: RPC больше не нужен
  [
    'host.call',
    "require('host')",
    'harness',
    'ctx.remote',
  ].forEach((forbidden) => {
    assert.ok(!record.includes(forbidden), `постоянная версия не должна зависеть от ${forbidden}`);
  });
});
