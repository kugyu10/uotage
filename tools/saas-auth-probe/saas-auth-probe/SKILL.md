---
name: saas-auth-probe
description: Safely set up and verify Vercel deployments, Supabase Email Magic Link authentication, Resend API keys and sending domains, and Stripe test webhooks in Node/Next.js projects. Use when the user asks to connect, authenticate, probe, deploy, or troubleshoot any combination of Vercel, Supabase Auth, Resend, or Stripe.
---

# SaaS Auth Probe

Use the bundled `scripts/probe.mjs` as the baseline in a project that uses the environment variables below. It never prints secret values.

## Workflow

1. Inspect existing project scripts and `.env.example`; preserve project-specific checks.
2. Copy or adapt `scripts/probe.mjs` into the project as `scripts/probe.mjs`, then add `"probe": "node scripts/probe.mjs"` to `package.json`.
3. Run `npm run probe` locally after each provider is configured. Do not ask the user to paste keys; ask only for the redacted probe section.
4. Run `npm run probe:vercel` before a Vercel deployment. It checks Vercel CLI authentication and project linking in addition to normal checks.
5. Keep local and production credentials separate. Verify the actual production URL after deployment.

## Required conventions

- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Use the public key only in browser/SSR Auth clients; never expose the service role key.
- Magic Link: test both delivery and callback with an invited operator. Confirm redirect URLs for localhost, preview, and production in Supabase Auth settings before declaring it complete.
- Resend: use a domain-scoped `Sending access` `RESEND_API_KEY`. If the domain status must be queried, keep a separate local-only `RESEND_PROBE_API_KEY` with `Full access`; never upload it to Vercel.
- Stripe: `STRIPE_WEBHOOK_SECRET` from `stripe listen` is local-only. Create a separate Dashboard webhook endpoint and `whsec_...` for Vercel production. Verify signature delivery before testing a real Checkout purchase.
- Vercel: set all server secrets with the CLI or dashboard; never put them in `NEXT_PUBLIC_*`. Set `NEXT_PUBLIC_APP_URL` to the exact environment URL.

## Safety

- Do not echo, log, commit, or request secrets in chat.
- Do not treat a key-format check as a webhook test. Require a signed event and a `200` response.
- Do not run migrations against a remote Supabase project without showing the planned migrations and getting approval.
- When a provider action requires a browser login, continue with local code and validation that do not require the login; record the exact remaining user action.

## Commands

```zsh
# Run directly against the current workspace.
node ~/.codex/skills/saas-auth-probe/scripts/probe.mjs --workspace .

# Include Vercel login and link checks.
node ~/.codex/skills/saas-auth-probe/scripts/probe.mjs --workspace . --vercel

# Local Stripe signature test: keep the listener running, put its whsec_ value
# only in .env.local, restart the app, then trigger a signed event.
stripe listen --forward-to localhost:3000/api/stripe/webhook
stripe trigger payment_intent.succeeded
```
