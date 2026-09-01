import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/uuid.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
const { isUuid } = await import(moduleUrl);

test('checkout accepts standard 36-character UUID product IDs', () => {
  assert.equal(isUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isUuid('A0EebC99-9C0B-4EF8-BB6D-6BB9BD380A11'), true);
});

test('checkout rejects malformed product IDs', () => {
  for (const value of [
    '', '550e8400e29b41d4a716446655440000', '550e8400-e29b-41d4-a716-44665544000',
    '550e8400-e29b-41d4-a716-446655440000-', '550e8400-e29b-41d4-a716-44665544000z',
  ]) assert.equal(isUuid(value), false, value);
});
