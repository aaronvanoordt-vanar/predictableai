# predictable.ai — Revenue OS

Spanish-language sales-intelligence SaaS. Static vanilla-JS frontend + Supabase backend (Auth, Postgres with RLS, Realtime, Deno edge functions that call the Anthropic API). No framework, no build step, no bundler.

## ⚠️ main IS production

GitHub Pages serves `main` directly at https://predictableai.vanarsi.com (see `CNAME`). **Merging a PR is a production deploy.** Before opening or updating any PR, run the `/preflight` skill (`.claude/skills/preflight/SKILL.md`). At minimum:

```bash
node scripts/check.mjs   # must print OK
```

## Run locally

```bash
python3 server.py    # or: node server.js — serves the app on :3000 and proxies Apollo API
```

There is no package.json, no npm install, no test suite. Verification = `scripts/check.mjs` + driving the app in a browser (Playwright works in web sessions).

## Architecture

- **Page flow:** `landing.html` → `auth.html` → `auth-callback.html` → `onboarding.html` → `index.html` (the app).
- **`index.html` is a ~6,200-line monolith**: all views, all CSS, and large inline `<script>` blocks (Apollo integration ~line 4600+, settings/auth UI ~5700+). Two production outages came from edits here: orphan leftover code causing a `SyntaxError` that killed every inline function (PR #18), and unbalanced `<div>`s causing a black screen on navigation (commit 0a151b4). After ANY edit to it, `node scripts/check.mjs` runs automatically via hook — if it fails, fix before continuing. Prefer adding new features as `js/` modules over growing the inline scripts.
- **Script load order matters** (globals, no modules): `js/config.js` → `js/supabase-client.js` → `js/auth-guard.js` → feature modules. Never reorder the `<script>` tags in `index.html` without checking dependencies.
- **Intelligence Hub = `js/intel-hub-cadence-tabs.js`**, mounted into `#ih-v2-shell` in `index.html`. Three older generations (`intel-hub.js`, `intel-hub-v2.js`, `intel-hub-real-data.js`) were deleted from the repo — do not resurrect them from git history.
- **`miforms/`** is a separate mini-app (feedback/intake survey), used as the Hub unlock gate.

## Supabase

- Project config in `js/config.js` (URL + anon key — the anon key is public by design; RLS enforces access).
- `supabase/migrations/` — applied to production. **Never modify an existing migration; always add a new file.** Note in the PR body that a migration must be applied.
- `supabase/functions/` — 4 Deno edge functions (`enrich-company`, `generate-intel-hub`, `schedule-intel-hub`, `apollo-proxy`). They do **not** auto-deploy; say "requires `supabase functions deploy <name>`" in the PR body when you change one.
- **All Apollo API calls go through the `apollo-proxy` edge function** (secret `APOLLO_API_KEY`, JWT required). Never call Apollo directly from the client or put its key in any file.
- Key tables: `profiles` (incl. `role`), `sales_reports`, `intelligence_hub_reports`, `client_icp`, credits. Roles: admin / director / SDR.

## Security invariants (violations have shipped before — see docs/SESSION_AUDIT_2026-07-02.md)

1. **Users must never be able to change their own `profiles.role`.** An anti-escalation trigger exists (security-hardening migration). Do not add UI, RLS, or RPC that writes `profiles.role` from the client.
2. **Never insert API/LLM/user data into the DOM via raw `innerHTML`.** Escape it (see `js/ui-helpers.js`) — XSS via Apollo/Supabase/LLM render paths was found and fixed in PR #25.
3. **Never hardcode API keys or secrets** in any file — this repo is publicly served. Secrets belong in Supabase edge-function env vars. (`scripts/check.mjs` scans for this.)
4. New RPC/functions: default-deny — revoke from `anon`/`PUBLIC` unless intentionally public (a credit-draining hole via `decrement_credits` shipped once).

## Product rules

- **No invented demo data — ever.** No fake metrics, fake teammates, fake briefs, fake badges, or hardcoded greetings. Empty states must be honest and actionable (all demo data was purged in PR #28; do not reintroduce it).
- **UI copy is neutral Latin-American Spanish** (tú, not vos: "dinos", "selecciona"). Code identifiers and commit messages in English are fine.
- **Do not restyle the app wholesale.** Follow the existing CSS custom properties/design tokens in `index.html`. The app has been fully re-themed 4 times; incremental, token-respecting changes only unless the task explicitly asks for a redesign.
- The app already had reversals like onboarding rebuilt 7 times. If a request contradicts an existing recent decision (e.g. re-hiding "Reportes" from SDRs, re-adding loading theatrics), flag the conflict instead of silently redoing it.

## PR conventions

- One session branch = one PR. Write the PR body as plain markdown (past sessions leaked `$(cat <<'EOF'` heredoc wrappers into PR bodies — don't).
- State in the body: what was verified locally, pending manual steps (migrations to apply, edge functions to deploy).

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /gstack-office-hours
- Strategy/scope → invoke /gstack-plan-ceo-review
- Architecture → invoke /gstack-plan-eng-review
- Design system/plan review → invoke /gstack-design-consultation or /gstack-plan-design-review
- Full review pipeline → invoke /gstack-autoplan
- Bugs/errors → invoke /gstack-investigate
- QA/testing site behavior → invoke /gstack-qa or /gstack-qa-only
- Code review/diff check → invoke /gstack-review
- Visual polish → invoke /gstack-design-review
- Ship/deploy/PR → invoke /gstack-ship or /gstack-land-and-deploy
- Save progress → invoke /gstack-context-save
- Resume context → invoke /gstack-context-restore
