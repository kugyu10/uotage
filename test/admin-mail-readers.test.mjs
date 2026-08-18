import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const readersPage = await readFile(
  new URL('../src/app/admin/mail/scenarios/[scenarioId]/readers/page.tsx', import.meta.url),
  'utf8',
);
const readerDetailPage = await readFile(
  new URL('../src/app/admin/mail/scenarios/[scenarioId]/readers/[readerId]/page.tsx', import.meta.url),
  'utf8',
);
const deliveriesPage = await readFile(
  new URL('../src/app/admin/mail/scenarios/[scenarioId]/deliveries/page.tsx', import.meta.url),
  'utf8',
);
const actions = await readFile(
  new URL('../src/app/admin/mail/scenarios/[scenarioId]/readers/actions.ts', import.meta.url),
  'utf8',
);
const addReaderForm = await readFile(
  new URL('../src/app/admin/mail/scenarios/[scenarioId]/readers/add-reader-form.tsx', import.meta.url),
  'utf8',
);

test('all three pages require an operator session and scope every query to the tenant', () => {
  for (const source of [readersPage, readerDetailPage, deliveriesPage, actions]) {
    assert.match(source, /requireOperator\(\)/);
  }
  // scenarios / scenario_readers / deliveries / labels / purchases / reader_labels queries
  // must all be filtered by the operator's own tenant_id, never a client-supplied value.
  for (const source of [readersPage, readerDetailPage, deliveriesPage]) {
    const tenantScopedQueries = source.match(/\.eq\("tenant_id", operator\.tenant_id\)/g) ?? [];
    assert.ok(tenantScopedQueries.length >= 2, `expected multiple tenant-scoped queries in: ${source.slice(0, 40)}`);
  }
});

test('scenario and reader route params are validated as UUIDs before hitting the database', () => {
  assert.match(readersPage, /if \(!isUuid\(scenarioId\)\) notFound\(\)/);
  assert.match(readerDetailPage, /if \(!isUuid\(scenarioId\) \|\| !isUuid\(readerId\)\) notFound\(\)/);
  assert.match(deliveriesPage, /if \(!isUuid\(scenarioId\)\) notFound\(\)/);
});

test('readers list supports search by email, registration path, label, purchase status, and unsubscribe status', () => {
  assert.match(readersPage, /readersQuery\.ilike\("readers\.email", `%\$\{emailFilter\}%`\)/);
  assert.match(readersPage, /readersQuery\.ilike\("registration_path", `%\$\{pathFilter\}%`\)/);
  assert.match(readersPage, /from\("reader_labels"\)/);
  assert.match(readersPage, /\.eq\("label_id", labelFilter\)/);
  assert.match(readersPage, /from\("purchases"\)/);
  assert.match(readersPage, /purchasedFilter === "yes" \? purchasedIds\.has\(row\.readers\.id\) : !purchasedIds\.has\(row\.readers\.id\)/);
  assert.match(readersPage, /readersQuery\.not\("readers\.unsubscribed_at", "is", null\)/);
  assert.match(readersPage, /readersQuery\.is\("readers\.unsubscribed_at", null\)/);
});

test('reader detail shows registration/deadline, granted labels, purchases, delivery history, and unsubscribe state', () => {
  assert.match(readerDetailPage, /from\("scenario_readers"\)/);
  assert.match(readerDetailPage, /enrollment\.registered_at/);
  assert.match(readerDetailPage, /enrollment\.deadline_at/);
  assert.match(readerDetailPage, /from\("reader_labels"\)/);
  assert.match(readerDetailPage, /granted_at/);
  assert.match(readerDetailPage, /from\("purchases"\)/);
  assert.match(readerDetailPage, /from\("deliveries"\)/);
  assert.match(readerDetailPage, /\.eq\("scenario_reader_id", enrollment\.id\)/);
  assert.match(readerDetailPage, /reader\.unsubscribed_at/);
});

test('individual add calls register_reader via the admin client, records a manual registration path, and never sends mail immediately', () => {
  assert.match(actions, /admin\.rpc\("register_reader"/);
  assert.match(actions, /target_tenant_id: operator\.tenant_id/);
  assert.match(actions, /target_registration_path: null/);
  assert.match(actions, /registration_path: MANUAL_REGISTRATION_PATH/);
  assert.match(actions, /const MANUAL_REGISTRATION_PATH = "manual"/);
  assert.doesNotMatch(actions, /sendInitialMail/);
  assert.doesNotMatch(actions, /resend/i);
  assert.match(addReaderForm, /即時送信は行わず/);
});

test('individual add refuses when the scenario has no funnel and verifies the funnel resolves back to this scenario', () => {
  assert.match(actions, /if \(!scenario\.funnel_id\)/);
  assert.match(actions, /このシナリオにはファネルが設定されていないため/);
  assert.match(actions, /resolvedScenario\.id !== scenarioId/);
  assert.match(actions, /trigger_type !== "registration"/);
});

test('deliveries log is scoped to this scenario via scenario_readers, ordered newest first, and filterable by status', () => {
  assert.match(deliveriesPage, /scenario_readers!inner\(scenario_id\)/);
  assert.match(deliveriesPage, /\.eq\("scenario_readers\.scenario_id", scenarioId\)/);
  assert.match(deliveriesPage, /order\("scheduled_at", \{ ascending: false \}\)/);
  assert.match(deliveriesPage, /DELIVERY_STATUSES/);
  assert.match(deliveriesPage, /deliveriesQuery\.eq\("status", statusFilter\)/);
});

test('reader pages link back to the shared scenario detail route without implementing it', async () => {
  for (const source of [readersPage, readerDetailPage, deliveriesPage]) {
    assert.match(source, /<Link href={`\/admin\/mail\/scenarios\/\$\{scenarioId\}`}>/);
  }
  // The scenario list/detail routes belong to another workstream — this route must not exist here.
  await assert.rejects(
    readFile(new URL('../src/app/admin/mail/scenarios/[scenarioId]/page.tsx', import.meta.url), 'utf8'),
    /ENOENT/,
  );
});
