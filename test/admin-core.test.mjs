import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function read(path) {
  return readFile(new URL(`../src/app/admin/${path}`, import.meta.url), 'utf8');
}

const TENANT_SCOPE = /\.eq\(\s*"tenant_id",\s*operator\.tenant_id\s*\)/;

const pages = {
  funnels: await read('funnels/page.tsx'),
  funnelsNew: await read('funnels/new/page.tsx'),
  funnelsEdit: await read('funnels/[id]/page.tsx'),
  products: await read('products/page.tsx'),
  productsNew: await read('products/new/page.tsx'),
  productsEdit: await read('products/[id]/page.tsx'),
  registrationPaths: await read('registration-paths/page.tsx'),
  labels: await read('labels/page.tsx'),
  courses: await read('courses/page.tsx'),
  settings: await read('settings/page.tsx'),
};

const actions = {
  funnels: await read('funnels/actions.ts'),
  products: await read('products/actions.ts'),
  registrationPaths: await read('registration-paths/actions.ts'),
  labels: await read('labels/actions.ts'),
  settings: await read('settings/actions.ts'),
};

test('funnels / products / registration-paths pages require an operator and scope queries by tenant', () => {
  for (const source of [
    pages.funnels,
    pages.funnelsNew,
    pages.funnelsEdit,
    pages.products,
    pages.productsNew,
    pages.productsEdit,
    pages.registrationPaths,
  ]) {
    assert.match(source, /requireOperator\(\)/);
    assert.match(source, TENANT_SCOPE);
  }
});

test('labels page requires an operator, is tenant-scoped, and shows per-label reader counts', () => {
  assert.match(pages.labels, /requireOperator\(\)/);
  assert.match(pages.labels, TENANT_SCOPE);
  assert.match(pages.labels, /reader_labels\(count\)/);
});

test('courses page requires an operator and scopes courses and purchasers by tenant', () => {
  assert.match(pages.courses, /requireOperator\(\)/);
  assert.match(pages.courses, TENANT_SCOPE);
  assert.match(pages.courses, /from\("purchases"\)/);
  assert.match(pages.courses, /content_url/);
});

test('settings page requires an operator, is tenant-scoped, and never renders raw Stripe secrets', () => {
  assert.match(pages.settings, /requireOperator\(\)/);
  assert.match(pages.settings, TENANT_SCOPE);
  assert.match(pages.settings, /process\.env\.STRIPE_SECRET_KEY/);
  assert.match(pages.settings, /process\.env\.STRIPE_WEBHOOK_SECRET/);
  assert.doesNotMatch(pages.settings, /\{process\.env\.STRIPE_SECRET_KEY\}/);
  assert.doesNotMatch(pages.settings, /\{process\.env\.STRIPE_WEBHOOK_SECRET\}/);
});

test('all admin Server Actions require an operator and scope writes to that operator tenant', () => {
  for (const source of Object.values(actions)) {
    assert.match(source, /^"use server";/m);
    assert.match(source, /requireOperator\(\)/);
    assert.match(source, /(?:tenant_id:\s*operator\.tenant_id|\.eq\(\s*"tenant_id",\s*operator\.tenant_id\s*\))/);
  }
});

test('funnel actions validate trigger type and require a product for purchase triggers', () => {
  assert.match(actions.funnels, /triggerType !== "registration"/);
  assert.match(actions.funnels, /triggerType === "purchase" && !productId/);
});

test('registration path actions validate the label belongs to the tenant before granting it', () => {
  assert.match(actions.registrationPaths, TENANT_SCOPE);
  assert.match(actions.registrationPaths, /from\("labels"\)/);
});

test('label rename and delete actions are scoped by both id and tenant_id', () => {
  assert.match(actions.labels, /\.eq\("tenant_id", operator\.tenant_id\)\s*\.eq\("id", id\)/);
});
