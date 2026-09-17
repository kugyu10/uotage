import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const proxy = await readFile(new URL('../src/proxy.ts', import.meta.url), 'utf8');
const admin = await readFile(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
const layout = await readFile(new URL('../src/app/admin/layout.tsx', import.meta.url), 'utf8');
const server = await readFile(new URL('../src/lib/supabase/server.ts', import.meta.url), 'utf8');

const sectionPages = [
  'mail/page.tsx',
  'courses/page.tsx',
  'labels/page.tsx',
  'settings/page.tsx',
  'funnels/page.tsx',
  'products/page.tsx',
  'registration-paths/page.tsx',
];
const sections = await Promise.all(
  sectionPages.map((path) => readFile(new URL(`../src/app/admin/${path}`, import.meta.url), 'utf8')),
);

test('admin routes require a verified session and operator membership', () => {
  assert.match(proxy, /getClaims\(\)/);
  assert.match(proxy, /matcher: \["\/admin\/:path\*"\]/);
  assert.match(server, /auth\.getUser\(\)/);
  assert.match(server, /from\("operators"\)/);
  assert.match(server, /if \(!operator\) redirect/);
  assert.match(admin, /requireOperator\(\)/);
  assert.match(layout, /requireOperator\(\)/);
  for (const section of sections) assert.match(section, /requireOperator\(\)/);
});

test('admin navigation uses UTAGE vocabulary', () => {
  for (const label of ['ファネル', 'メール配信', '会員サイト', 'ラベル', '管理メニュー']) assert.ok(layout.includes(label));
});
