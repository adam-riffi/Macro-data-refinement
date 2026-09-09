import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('every authored browser method has its own named behavioral unit test', async () => {
  const missing = [];
  for (const moduleName of ['game', 'field', 'session', 'terminal']) {
    const source = new URL(`../../public/assets/${moduleName}.js`, import.meta.url);
    const components = await import(source.href);
    const testFile = new URL(`./${moduleName}.test.js`, import.meta.url);
    const tests = existsSync(testFile) ? readFileSync(testFile, 'utf8') : '';
    const names = [...tests.matchAll(/\btest\(\s*(['"])([^'"\n]+)\1/g)].map((match) => match[2]);
    for (const [className, component] of Object.entries(components)) {
      if (typeof component !== 'function') continue;
      const methods = component.prototype ? Object.getOwnPropertyNames(component.prototype) : [];
      const statics = Object.getOwnPropertyNames(component).filter(
        (name) => !['length', 'name', 'prototype', 'arguments', 'caller'].includes(name),
      );
      for (const method of [...methods, ...statics]) {
        const prefix = `${className}.${method} `;
        if (!names.some((name) => name.startsWith(prefix))) {
          missing.push(`${moduleName}.js: ${prefix.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    'Each browser constructor and method needs a dedicated behavioral test.',
  );
});
