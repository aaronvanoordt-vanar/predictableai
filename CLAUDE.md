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
- **`index.html` is a ~5,000-line monolith**: all views, all CSS, and large inline `<script>` blocks (nav/theme, coach/reports, settings/auth UI). Two production outages came from edits here: orphan leftover code causing a `SyntaxError` that killed every inline function (PR #18), and unbalanced `<div>`s causing a black screen on navigation (commit 0a151b4). After ANY edit to it, `node scripts/check.mjs` runs automatically via hook — if it fails, fix before continuing. Prefer adding new features as `js/` modules over growing the inline scripts.
- **Prospección = `js/prospecting.js` (UI, 4 tabs: Búsqueda / Listas / Secuencias / WhatsApp & LinkedIn) + `js/prospecting-data.js` (data layer)**, mounted into `#prospecting-shell` in page `pro-main`. Lists live in Supabase (`prospect_lists` / `prospect_list_members`), NOT localStorage. The old inline "Apollo Prospecting Engine" and `js/apollo-sequences.js` were removed (PR #31) — do not resurrect them.
- **Script load order matters** (globals, no modules): `js/config.js` → `js/supabase-client.js` → `js/auth-guard.js` → feature modules. Never reorder the `<script>` tags in `index.html` without checking dependencies.
- **Contexto de la empresa = `js/company-context.js` + la vista `renderResearch()` de `js/intel-hub-cadence-tabs.js`** (página `mi-research`, shell `#ih-research-shell`). Es el **primer paso obligatorio** del journey: 13 tarjetas en dos bloques — **A. Tu empresa** (datos internos) y **B. A quién le vendes** (el ICP, con la taxonomía de Apollo de `js/apollo-enums.js`, no texto libre). `company-context.js` es la única definición de qué campos existen, cuáles son obligatorios y cómo se leen; `intel-hub-cadence-tabs.js` solo los envuelve en el acordeón. El ICP **se declara aquí y de aquí sale todo lo demás** — no al revés: `syncIcpFromSearch` (en `js/prospecting-data.js`) ya no pisa un ICP declarado.
- **`js/context-gate.js` bloquea el resto de la plataforma** (radar, hub, CODA, prospección, WhatsApp, ventas/coach) hasta que `CompanyContext.completeness()` dé `complete` = campos obligatorios llenos **Y** `intel_hub_intake.context_confirmed_at` puesto por el usuario. Que la IA haya llenado los campos no equivale a que él los revisó. Quedan libres el dashboard (con banner), el propio contexto, Clientes y Ajustes.
- **Intelligence Hub = `js/intel-hub-cadence-tabs.js`**, mounted into `#ih-v2-shell` in `index.html`. Three older generations (`intel-hub.js`, `intel-hub-v2.js`, `intel-hub-real-data.js`) were deleted from the repo — do not resurrect them from git history.
- **Clients = `js/clients.js`** (grid of client cards + per-client dashboard: status, links, CRM metrics + Google Sheets embed, PDF materials, target countries), mounted into `#clients-shell` in page `clients`. Data in `clients`/`client_materials`/`client_access` tables + private storage bucket `client-assets` (signed URLs only). Each client row has a `share_token`; **`client.html` + `js/client-portal.js`** is the standalone read-only portal (`client.html?token=…`) where the end client signs up and gets bound via the `claim_client_access` RPC — client.html must NOT load `auth-guard.js`.
- **`miforms/`** is a separate mini-app (feedback/intake survey). It is **optional**, not a gate — `auth-callback.html` always routes into `index.html` after onboarding. `js/miforms-prompt.js` offers it in-app via a sidebar affordance and a one-time dismissible popup, both promising a credit bonus (`claim_miforms_bonus_credits` RPC) for completing it.

## Motores de IA (Claude / OpenAI / Perplexity)

Cada función con IA puede correr sobre cualquiera de los tres motores. La preferencia vive en `profiles.ai_engines` (JSONB, una clave por función) y se resuelve en dos lugares que **deben mantenerse en sync**:

- `supabase/functions/_shared/llm.ts` — `RECOMMENDED_ENGINE` + `callLLM()`, el único sitio que sabe hablar con cada proveedor (web search, JSON schema, PDFs, reintentos). Toda edge function con IA pasa por aquí; ninguna vuelve a llamar a `api.anthropic.com` directamente.
- `js/ai-engine.js` — `FEATURES` + el selector (`AIEngine.mount(...)` o `<div data-ai-engine="coda">`).

Recomendados: `intel_hub` y `coda` (Contexto estratégico IA) → **Perplexity**; `outreach`, `onboarding` y `radar` → **Claude**; `coach` → **OpenAI**.

Reglas:
- El motor del body de la request es solo un atajo: la edge function **siempre** revalida contra su allowlist y cae al recomendado si no reconoce el valor.
- Si falta la API key del motor elegido (o el motor no puede con esa llamada, p. ej. Perplexity + PDF), `callLLM` cae a Claude y lo loguea — nunca rompe la función.
- Secrets: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`. Modelos overridables con `OPENAI_MODEL` (default `gpt-5`) y `PERPLEXITY_MODEL` (default `sonar-pro`).
- Excepción conocida: el coach en vivo del navegador (`js/realtime-coach.js`) usa el worker `/openai` cuando el motor es OpenAI; con Claude/Perplexity resuelve el turno en la acción `coachTurn` de `sales-coach`.

## Supabase

- Project config in `js/config.js` (URL + anon key — the anon key is public by design; RLS enforces access).
- `supabase/migrations/` — applied to production. **Never modify an existing migration; always add a new file.** Note in the PR body that a migration must be applied.
- `supabase/functions/` — 7 Deno edge functions (`enrich-company`, `generate-intel-hub`, `schedule-intel-hub`, `apollo-proxy`, `apollo-webhook`, `generate-outreach`, `generate-client-brief`). They do **not** auto-deploy; say "requires `supabase functions deploy <name>`" in the PR body when you change one. **`apollo-webhook` must be deployed with `--no-verify-jwt`** (Apollo calls it; it self-authenticates via `?token=` against `APOLLO_WEBHOOK_SECRET`) — redeploying it with JWT verification silently breaks async phone reveals.
- **All Apollo API calls go through the `apollo-proxy` edge function** (secret `APOLLO_API_KEY`, JWT required). Never call Apollo directly from the client or put its key in any file.
- Key tables: `profiles` (incl. `role`), `sales_reports`, `intelligence_hub_reports`, `client_icp`, `client_brief`, `prospect_lists`/`prospect_list_members` (client-writable, owner-scoped RLS), credits. Roles: admin / director / SDR.
- **El ICP declarado manda sobre cualquier inferencia.** `intel_hub_intake` guarda los valores exactos en arrays (`icp_countries`, `icp_industry_tags`, `icp_employee_ranges`, `icp_departments`, `icp_seniorities`, `icp_titles`) y las columnas de texto viejas (`icp_industries`/`icp_roles`/`icp_geographies`/`icp_company_sizes`) se siguen escribiendo como **espejo** (`CompanyContext.legacyMirror` en el cliente, el mismo criterio en `enrich-company`) para no romper a quien ya las lee. `generate-client-brief` deriva `recommended_filters` de forma determinista con `filtersFromDeclaredIcp()` — antes lo adivinaba un LLM a partir de texto libre. La allowlist compartida vive en `supabase/functions/_shared/icp-taxonomy.ts`: **es espejo exacto de `js/apollo-enums.js`, actualiza los dos en el mismo PR.**
- **`client_brief` ("MI Cliente") is the glue between the 3 modules**: `generate-client-brief` builds it from `intel_hub_intake` + web research (fired automatically when the hub generates); `generate-outreach` consumes it (plus ready hub reports) to write 5-layer personalized outreach; Prospección's "Búsqueda recomendada" applies its `recommended_filters` and auto-broadens to ≥1000 people; the coach receives the lead's saved `outreach.angle` via "Preparar reunión con el coach".

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
