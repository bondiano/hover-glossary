/**
 * hover-glossary / test/run.mjs
 *
 * Последовательно загружает все тестовые файлы.
 * Почему так: песочница запрещает запуск дочерних процессов node --test
 * (spawn EPERM), поэтому тестовые файлы импортируются динамически в одном
 * процессе, а node:test сам выводит сводку.
 *
 * Запуск: node test/run.mjs   (или npm test)
 */
import test from 'node:test';

const files = ['./lexicon.test.mjs', './inline-artifact.test.mjs', './plugin-source.test.mjs'];

for (const file of files) {
  await import(file);
}

// После top-level await node:test выводит все результаты, когда очередь задач
// опустеет.
await new Promise((done) => test.after(() => done()));
