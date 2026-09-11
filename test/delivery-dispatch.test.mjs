import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const sql = (await readFile(new URL('../supabase/migrations/20260815030000_delivery_dispatch_claim.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const purchaseSkipFix = (await readFile(new URL('../supabase/migrations/20260815040000_purchase_delivery_skip_fix.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const targetedClaim = (await readFile(new URL('../supabase/migrations/20260815050000_targeted_delivery_claim.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const cronConfiguration = (await readFile(new URL('../supabase/migrations/20260817010000_configure_delivery_cron.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const edge = await readFile(new URL('../supabase/functions/dispatch-deliveries/index.ts', import.meta.url), 'utf8');
const deployScriptPath = new URL('../scripts/deploy-delivery-worker.mjs', import.meta.url);
const deployScript = await readFile(deployScriptPath, 'utf8');
const registration = await readFile(new URL('../src/app/api/registrations/route.ts', import.meta.url), 'utf8');
const workerIndex = await readFile(new URL('../workers/dispatch-cron/src/index.ts', import.meta.url), 'utf8');
const wranglerConfig = await readFile(new URL('../workers/dispatch-cron/wrangler.jsonc', import.meta.url), 'utf8');

function runDeployScriptDryRun(extraArgs, envOverrides = {}) {
  // --dry-run は --confirm より前で process.exit(0) するため、外部への副作用
  // （supabase CLI呼び出し・secrets書き込み）は一切発生しない（scripts/deploy-delivery-worker.mjs 参照）。
  const env = {
    ...process.env,
    SUPABASE_PROJECT_REF: 'test-ref',
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    ...envOverrides,
  };
  try {
    const stdout = execFileSync(
      process.execPath,
      [deployScriptPath.pathname, '--app-url', 'https://example.com', '--dry-run', ...extraArgs],
      { env, encoding: 'utf8' },
    );
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

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

test('delivery deployment synchronizes one secret to Vault and a one-minute cron job', () => {
  assert.match(cronConfiguration, /create extension if not exists pg_cron/);
  assert.match(cronConfiguration, /create extension if not exists pg_net/);
  assert.match(cronConfiguration, /vault\.update_secret/);
  assert.match(cronConfiguration, /cron\.unschedule/);
  assert.match(cronConfiguration, /dispatch-deliveries-every-minute/);
  assert.match(cronConfiguration, /'\* \* \* \* \*'/);
  assert.match(cronConfiguration, /timeout_milliseconds := 15000/);
  assert.match(cronConfiguration, /grant execute on function public\.configure_delivery_cron\(text, text\) to service_role/);
  assert.match(deployScript, /rest\/v1\/rpc\/configure_delivery_cron/);
  assert.match(deployScript, /p_cron_secret: cronSecret/);
  assert.doesNotMatch(cronConfiguration, /[a-za-z0-9_-]{40,}/);
});

test('deploy script defaults to skipping pg_cron reconfiguration and leaving CRON_SECRET untouched (#7 🔴-1)', () => {
  const { status, stdout } = runDeployScriptDryRun([]);
  assert.equal(status, 0);
  const summary = JSON.parse(stdout);
  assert.equal(summary.configurePgCron, false);
  assert.equal(summary.cronSecretRotation, 'unchanged');
});

test('deploy script refuses --configure-pg-cron without a cron secret source (#7 🔴-1)', () => {
  const { status, stderr } = runDeployScriptDryRun(['--configure-pg-cron']);
  assert.notEqual(status, 0);
  assert.match(stderr, /--cron-secret.*--rotate-cron-secret/);
});

test('deploy script accepts an explicit --cron-secret for pg_cron reconfiguration (#7 🔴-1)', () => {
  const { status, stdout } = runDeployScriptDryRun(['--configure-pg-cron', '--cron-secret', 'test-secret-value']);
  assert.equal(status, 0);
  const summary = JSON.parse(stdout);
  assert.equal(summary.configurePgCron, true);
  assert.equal(summary.cronSecretRotation, 'explicit');
});

test('deploy script refuses a random --rotate-cron-secret with no way for the operator to retrieve it (#7 🔴-1)', () => {
  const { status, stderr } = runDeployScriptDryRun(['--rotate-cron-secret']);
  assert.notEqual(status, 0);
  assert.match(stderr, /--cron-secret.*--secret-out/);
});

test('deploy script allows --rotate-cron-secret when --secret-out is given (#7 🔴-1)', () => {
  const { status, stdout } = runDeployScriptDryRun(['--rotate-cron-secret', '--secret-out', '/tmp/uotage-cron-secret-test.txt']);
  assert.equal(status, 0);
  const summary = JSON.parse(stdout);
  assert.equal(summary.cronSecretRotation, 'random');
});

test('Cloudflare Workers cron trigger is configured for a 1-minute schedule with no plaintext vars (#7)', () => {
  assert.match(wranglerConfig, /"crons":\s*\["\* \* \* \* \*"\]/);
  assert.doesNotMatch(wranglerConfig, /^\s*"vars"\s*:/m);
});

test('dispatch-cron worker reports Edge Function failures as a failed invocation instead of swallowing them (#7 🟡-1)', () => {
  // Cloudflareのscheduledハンドラは失敗しても自動リトライしない
  // （https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ で確認済み）。
  // 握りつぶすとCron TriggersのPast Eventsが常に成功扱いになり、配信停止に誰も気づけない。
  assert.match(workerIndex, /throw new Error\(message\)/);
  assert.match(workerIndex, /throw error instanceof Error \? error : new Error\(message\)/);
  assert.doesNotMatch(workerIndex, /if \(!response\.ok\) \{\s*console\.error\([^)]*\);\s*return;/);
});
