import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const coursePage = await readFile(new URL('../src/app/course/[productId]/page.tsx', import.meta.url), 'utf8');
const edge = await readFile(new URL('../supabase/functions/dispatch-deliveries/index.ts', import.meta.url), 'utf8');
const mail = await readFile(new URL('../src/lib/mail.ts', import.meta.url), 'utf8');
const registration = await readFile(new URL('../src/app/api/registrations/route.ts', import.meta.url), 'utf8');
const claimDeliveriesMigration = (await readFile(new URL('../supabase/migrations/20260819010000_claim_deliveries_member_url.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const registerReaderMigration = (await readFile(new URL('../supabase/migrations/20260819011000_register_reader_member_url.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();

test('course page validates the access token and the purchase record before rendering', () => {
  assert.match(coursePage, /export const dynamic = "force-dynamic"/);
  assert.match(coursePage, /from\("readers"\)\.select\("id"\)/);
  assert.match(coursePage, /\.eq\("access_token", token\)/);
  assert.match(coursePage, /if \(!reader\) notFound\(\)/);
  assert.match(coursePage, /from\("purchases"\)\.select\("id"\)/);
  assert.match(coursePage, /\.eq\("reader_id", reader\.id\)\.eq\("product_id", productId\)/);
  assert.match(coursePage, /if \(!purchase\) notFound\(\)/);
  assert.match(coursePage, /if \(!product\?\.content_url \|\| !isHttpUrl\(product\.content_url\)\) notFound\(\)/);
});

test('course page embeds the content URL without ever re-emitting the access token', () => {
  assert.match(coursePage, /<iframe src=\{product\.content_url\}/);
  assert.match(coursePage, /allowFullScreen/);
  assert.doesNotMatch(coursePage, /\{token\}/);
});

test('dispatcher and initial mail resolve {{member_url}} from the funnel product, falling back to the app URL', () => {
  assert.match(edge, /product_id: string \| null;/);
  assert.match(edge, /const memberUrl = item\.product_id \? `\$\{appUrl\}\/course\/\$\{item\.product_id\}\?token=\$\{encodeURIComponent\(item\.access_token\)\}` : appUrl;/);
  assert.match(edge, /"\{\{member_url\}\}": memberUrl/);
  assert.match(mail, /productId: string \| null;/);
  assert.match(mail, /const memberUrl = mail\.productId \? `\$\{appUrl\}\/course\/\$\{mail\.productId\}\?token=\$\{encodeURIComponent\(mail\.accessToken\)\}` : appUrl;/);
  assert.match(mail, /"\{\{member_url\}\}": memberUrl/);
  assert.match(registration, /product_id: string \| null;/);
  assert.match(registration, /productId: enrollment\.product_id/);
});

test('claim_deliveries returns the funnel product_id so the worker can resolve {{member_url}}', () => {
  assert.match(claimDeliveriesMigration, /drop function public\.claim_deliveries\(integer, uuid\)/);
  assert.match(claimDeliveriesMigration, /booking_url text, deadline_at timestamptz, product_id uuid/);
  assert.match(claimDeliveriesMigration, /funnel\.slug, funnel\.booking_url, enrollment\.deadline_at, funnel\.product_id/);
  assert.match(claimDeliveriesMigration, /grant execute on function public\.claim_deliveries\(integer, uuid\) to service_role/);
});

test('register_reader returns the (always-null) funnel product_id so the initial mail shape matches the dispatcher', () => {
  assert.match(registerReaderMigration, /drop function public\.register_reader\(uuid, text, text, text, text, text, text\)/);
  assert.match(registerReaderMigration, /initial_delivery_id uuid, product_id uuid/);
  assert.match(registerReaderMigration, /first_step\.delivery_id, selected_funnel\.product_id/);
  assert.match(registerReaderMigration, /grant execute on function public\.register_reader\(uuid, text, text, text, text, text, text\) to service_role/);
});
