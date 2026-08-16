import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const offerPage = await readFile(new URL('../src/app/offer/[slug]/page.tsx', import.meta.url), 'utf8');
const accessLayer = await readFile(new URL('../src/lib/public-access.ts', import.meta.url), 'utf8');
const mail = await readFile(new URL('../src/lib/mail.ts', import.meta.url), 'utf8');
const unsubscribePage = await readFile(new URL('../src/app/unsubscribe/page.tsx', import.meta.url), 'utf8');
const unsubscribeForm = await readFile(new URL('../src/app/unsubscribe/unsubscribe-form.tsx', import.meta.url), 'utf8');
const unsubscribeRoute = await readFile(new URL('../src/app/api/unsubscribe/route.ts', import.meta.url), 'utf8');

test('booking URL is only rendered from a server-validated active offer', () => {
  assert.match(offerPage, /const offer = await findActiveOffer/);
  assert.match(offerPage, /if \(!offer\) redirect\("\/offer-ended"\)/);
  assert.match(accessLayer, /deadline_at\)\.getTime\(\) <= now\.getTime\(\)/);
  assert.match(accessLayer, /\.eq\("status", "active"\)/);
  assert.equal(offerPage.indexOf('if (!offer)'), offerPage.lastIndexOf('if (!offer)'));
  assert.ok(offerPage.indexOf('if (!offer)') < offerPage.indexOf('offer.bookingUrl'));
});

test('mail exposes separate confirmation and one-click unsubscribe URLs', () => {
  assert.match(mail, /\/unsubscribe\?u=/);
  assert.match(mail, /\/api\/unsubscribe\?u=/);
  assert.match(mail, /"List-Unsubscribe-Post": "List-Unsubscribe=One-Click"/);
});

test('unsubscribe link shows an already-unsubscribed state and reports write failures', () => {
  assert.match(unsubscribePage, /select\("unsubscribed_at"\)/);
  assert.match(unsubscribePage, /isAlreadyUnsubscribed/);
  assert.match(unsubscribeForm, /if \(alreadyUnsubscribed\) return null/);
  assert.match(unsubscribeForm, /if \(!response\.ok\) throw/);
  assert.match(unsubscribeRoute, /if \(error\) return Response\.json\(\{ ok: false \}, \{ status: 500 \}\)/);
});
