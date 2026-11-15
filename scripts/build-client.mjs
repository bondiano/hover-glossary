/**
 * hover-glossary / scripts/build-client.mjs
 *
 * Собирает артефакты из единственной реализации в src/:
 *
 * 1. plugin/cordis-define.json — тела функций { host, client } динамического
 *    плагина (живёт в процессе, исчезает после перезапуска).
 * 2. lib/ — сам корень репозитория является устанавливаемым профильным пакетом:
 *      lib/index.js      host-половина: пустой apply (всё на клиенте)
 *      lib/client.js     browser module: window.__ModuleLoader__.load({ id, factory })
 *
 * Корневой package.json — манифест публикации, он правится вручную;
 * скрипт его не генерирует. После правки полей запустите контрактные тесты
 * из test/.
 *
 * Полностью клиентская схема: словарь встроен в браузерную сборку, RPC и
 * сервисы сессии не нужны.
 *
 * Запуск: node scripts/build-client.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Убирает блочные JSDoc-комментарии (в них бывает слово import, мешающее разбору замыкания) */
function stripDocs(source) {
  return source.replace(/\/\*\*[\s\S]*?\*\//g, '');
}

/** Убирает ключевое слово export у ESM, оставляя реализацию */
function stripExports(source) {
  return source.replace(/^export\s+(?=(class|function|const|let|var)\b)/gm, '');
}

/** @param {string} relPath */
function loadInline(relPath) {
  let code = readFileSync(resolve(root, relPath), 'utf8');
  code = stripDocs(code);
  code = code.replace(/^\/\*[\s\S]*?\*\/\s*/, '');
  code = stripExports(code);
  return code.trim();
}

/**
 * Формирует встроенный исходник (экспортируется, чтобы тесты использовали
 * ту же логику и не расходились со сборкой).
 * @returns {string}
 */
export function buildInlineSource() {
  const lexiconCode = loadInline('src/lexicon.mjs');
  const seedCode = loadInline('src/seed-data.mjs');
  return `/* Сгенерировано scripts/build-client.mjs, править вручную нельзя; после правок src/ пересоберите */
${lexiconCode}

/* ---- встроенный словарь (из src/seed-data.mjs) ---- */
${seedCode}
`;
}

const INLINE_MARKER =
  /\/\* =+ начало встроенного блока[^*]*\*\/\n[ \t]*\/\*__INLINE_SOURCE__\*\/\n[ \t]*\/\* =+ конец встроенного блока =+ \*\//;

/**
 * Подставляет в шаблон встроенную копию src/ вместо плейсхолдера.
 * @param {string} relPath
 * @returns {string}
 */
export function composeTemplate(relPath) {
  const template = readFileSync(resolve(root, relPath), 'utf8');
  if (!INLINE_MARKER.test(template)) throw new Error(`${relPath}: нет маркеров встроенного блока`);
  const composed = template.replace(
    INLINE_MARKER,
    `/* ===== начало встроенного блока (сгенерировано build-client.mjs из src/) ===== */\n${buildInlineSource()}\n/* ===== конец встроенного блока ===== */`,
  );
  const start = composed.indexOf('начало встроенного блока');
  const end = composed.indexOf('конец встроенного блока', start);
  if (start < 0 || end < 0 || composed.slice(start, end).includes('__INLINE_SOURCE__')) {
    throw new Error(`${relPath}: в встроенном блоке остался плейсхолдер`);
  }
  return composed;
}

/**
 * Проверяет, что исходник — синтаксически корректное тело функции
 * (new Function только проверяет синтаксис, не выполняя код).
 * @param {string} source
 * @param {string} label
 */
export function assertParses(source, label) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(source);
  } catch (error) {
    throw new Error(`проверка синтаксиса ${label} не прошла: ${error.message}`);
  }
  return true;
}

/** Host-половина динамического плагина (RPC harness.handle, только внутри процесса) */
function buildDynamicHostSource() {
  const composed = composeTemplate('plugin/host-service.js');
  if (/^\s*(import|export)\s/m.test(composed)) throw new Error('в host-половине не должно быть import/export');
  assertParses(composed, 'dynamic host');
  return composed;
}

/** Host-половина статического профильного пакета: всё на клиенте, Host ничего не делает */
export function buildPackageHostSource() {
  return [
    '// hover-glossary profile package: host loader entry.',
    '// Плагин полностью клиентский (словарь встроен в client bundle), host-сервисов нет.',
    'function apply() {}',
    'export { apply };',
    '',
  ].join('\n');
}

export function build() {
  const out = buildInlineSource();

  mkdirSync(resolve(root, 'plugin'), { recursive: true });
  writeFileSync(resolve(root, 'plugin/client-inline.js'), out, 'utf8');

  // ---- артефакт 1: динамический плагин ----
  const dynamicHost = buildDynamicHostSource();
  const browserModule = composeTemplate('plugin/client-panel.js');
  assertParses(browserModule, 'browser module');

  writeFileSync(
    resolve(root, 'plugin/cordis-define.json'),
    JSON.stringify(
      {
        name: 'Толковый словарь при наведении',
        purpose: 'показывает 1..N толкований слова, на которое наведён курсор в тексте диалога',
        code: { host: dynamicHost, client: browserModule },
      },
      null,
      2,
    ),
    'utf8',
  );

  // ---- артефакт 2: устанавливаемый пакет в корне репозитория (lib/) ----
  mkdirSync(resolve(root, 'lib'), { recursive: true });
  writeFileSync(resolve(root, 'lib/index.js'), buildPackageHostSource(), 'utf8');
  writeFileSync(resolve(root, 'lib/client.js'), browserModule, 'utf8');

  console.log(`[build] plugin/client-inline.js (${out.length} символов)`);
  console.log(`[build] plugin/cordis-define.json (host ${dynamicHost.length} / client ${browserModule.length})`);
  console.log('[build] lib/ (index.js + client.js)');
}

// Если тесты импортируют чистые функции сборки, артефакты перезаписывать нельзя,
// иначе проверка «артефакты устарели» чинит сам проверяемый файл.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) build();
