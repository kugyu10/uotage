import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const sql = (await readFile(new URL('../supabase/migrations/20260815030000_delivery_dispatch_claim.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const purchaseSkipFix = (await readFile(new URL('../supabase/migrations/20260815040000_purchase_delivery_skip_fix.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const targetedClaim = (await readFile(new URL('../supabase/migrations/20260815050000_targeted_delivery_claim.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const edge = await readFile(new URL('../supabase/functions/dispatch-deliveries/index.ts', import.meta.url), 'utf8');
const deployScript = await readFile(new URL('../scripts/deploy-delivery-worker.mjs', import.meta.url), 'utf8');
const registration = await readFile(new URL('../src/app/api/registrations/route.ts', import.meta.url), 'utf8');

test('dispatcher atomically claims at most 500 and recovers stale work', () => {
  assert.match(sql, /for update skip locked limit batch_limit/);
  assert.match(sql, /batch_limit > 500/);
  assert.match(sql, /processing_started_at < now\(\) - interval '10 minutes'/);
  assert.match(sql, /processing_started_at is null and delivery\.scheduled_at < now\(\) - interval '10 minutes'/);
  assert.match(sql, /attempt_count >= 3 then 'failed' else 'queued'/);
});

test('failed immediate delivery is safely returned to the queue with its error', () => {
  assert.match(registration, /update\(\{ processing_started_at: new Date\(\)\.toISOString\(\), error_message: null \}\)/);
  assert.match(registration, /if \(claimError \|\| !claimed\) throw/);
  assert.match(registration, /update\(\{ status: "queued", processing_started_at: null, error_message:/);
  assert.match(registration, /\.eq\("id", enrollment\.initial_delivery_id\)\.eq\("status", "processing"\)/);
});

test('dispatcher batches 100 messages with a stable idempotency key', () => {
  assert.match(edge, /chunks\(\(data \?\? \[\]\) as Delivery\[\], 100\)/);
  assert.match(edge, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(edge, /"Idempotency-Key": await idempotencyKey\(batch\)/);
  assert.match(edge, /https:\/\/api\.resend\.com\/emails\/batch/);
  assert.match(edge, /"\{\{booking_url\}\}": item\.booking_url \?\? ""/);
});

test('purchase-triggered scenarios are not skipped merely because the reader purchased', () => {
  assert.match(purchaseSkipFix, /funnel\.id = scenario\.funnel_id and funnel\.trigger_type = 'registration'/);
});

test('a manual delivery test can claim only the explicitly selected delivery', () => {
  assert.match(targetedClaim, /drop function public\.claim_deliveries\(integer\)/);
  assert.match(targetedClaim, /target_delivery_id is null or delivery\.id = target_delivery_id/);
  assert.match(edge, /target_delivery_id: targetDeliveryId/);
  assert.match(edge, /batch_limit: targetDeliveryId \? 1 : 500/);
  assert.match(deployScript, /--delivery-id <queued delivery UUID>/);
  assert.match(deployScript, /"x-uotage-delivery-id": deliveryId/);
});

test('delivery deployment keeps its worker secret out of logs and removes temporary files', () => {
  assert.match(deployScript, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(deployScript, /"--env-file", secretFile/);
  assert.match(deployScript, /await rm\(secretDir, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(deployScript, /console\.log\([^\n]*cronSecret/);
  assert.doesNotMatch(deployScript, /SUPABASE_SERVICE_ROLE_KEY=\$\{required/);
});
