import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/registration.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
const { createUrlToken, parseRegistrationInput } = await import(moduleUrl);

test('registration input is normalized and bounded', () => {
  assert.deepEqual(parseRegistrationInput({ email: ' Reader@Example.COM ', name: ' 花子 ', funnelSlug: 'gift-1', registrationPath: 'x_1', website: '' }), {
    email: 'reader@example.com', name: '花子', funnelSlug: 'gift-1', registrationPath: 'x_1', website: '',
  });
  assert.throws(() => parseRegistrationInput({ email: 'invalid', funnelSlug: 'gift-1' }));
  assert.throws(() => parseRegistrationInput({ email: 'a@b.co', funnelSlug: '../admin' }));
});

test('URL tokens have at least 256 bits of random input and are URL safe', () => {
  const first = createUrlToken();
  const second = createUrlToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});
