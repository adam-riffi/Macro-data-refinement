import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as components from '../../public/assets/game.js';

test('every authored browser method has its own named behavioral unit test', () => {
  const tests = readFileSync(new URL('./game.test.js', import.meta.url), 'utf8');
  const names = [...tests.matchAll(/test\(\s*'([^']+)'/g)].map((match) => match[1]);
  const missing = [];
  for (const [className, component] of Object.entries(components)) {
    for (const method of Object.getOwnPropertyNames(component.prototype)) {
      const prefix = `${className}.${method} `;
      if (!names.some((name) => name.startsWith(prefix))) missing.push(prefix.trim());
    }
  }
  assert.deepEqual(
    missing,
    [],
    'Each browser constructor and method needs a dedicated behavioral test.',
  );
});
