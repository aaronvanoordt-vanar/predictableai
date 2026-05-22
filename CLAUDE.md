# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
test -d ~/.claude/skills/gstack/bin && echo "GSTACK_OK" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing.
Use ~/.claude/skills/gstack/... for gstack file paths (the global path).

The repo enforces this via `.claude/hooks/check-gstack.sh` (PreToolUse hook on
Skill) — Skill calls are blocked until gstack is present.

## Repo shape

Pure **static frontend** (HTML/CSS/JS, no build step, no `package.json`, no
tests, no linter). Deployed to `predictableai.vanarsi.com` via the `CNAME`
file (GitHub Pages-style host). Comments and UI are in **Spanish** — match
the language when editing existing strings/comments.

## Running locally

Two equivalent local dev servers — pick one:

```bash
node server.js     # Node, port 3000
python3 server.py  # Python stdlib, port 3000
```

Both serve `index.html` at `/` and proxy `POST /proxy/apollo/*` to
`api.apollo.io/api/v1/*`, injecting an `X-Api-Key` so the browser can hit
Apollo without CORS. The proxy is **dev-only**; production never calls Apollo
directly from the browser — it goes through the Apps Script backend
(`js/api.js`). Both server files contain hardcoded Apollo keys; treat them as
local dev fixtures, not deployment artifacts.

There is no test suite or lint config — verification is manual (open the
served page, exercise the flow). Use `/qa` (gstack) when a structured pass is
needed.

## Architecture

### Pages and their roles

- `landing.html` — public marketing page (no app code).
- `auth.html` + `js/auth.js` — Supabase email/password + Google OAuth.
- `auth-callback.html` — OAuth return URL; parses session from hash and
  routes to onboarding or app.
- `onboarding.html` + `js/onboarding.js` — captures LinkedIn **company**
  URL (regex enforces `/company/<slug>`, rejects `/in/<person>`), sets
  `profiles.onboarded = true`.
- `index.html` — the main app, **~3700 lines** with inline `<style>` and
  three inline `<script>` blocks. The HTML is a single SPA-ish shell; the
  `js/*.js` modules attach to DOM via `data-icp="…"` / `data-apollo="…"`
  attributes and `#page-pro-*` page-container IDs.

### JS modules (`js/`)

Every module is an **IIFE** `(function(global){…})(window)` that exposes a
single namespace on `window`. There is no bundler — script load order in the
HTML is load-bearing. Required order on `index.html`:

```
supabase-js (CDN) → js/config.js → js/supabase-client.js → js/auth-guard.js
→ js/ui-helpers.js → js/api.js → js/icp-builder.js → js/apollo-sequences.js
→ js/meeting-coach.js → js/realtime-coach.js
```

`auth-guard.js` **must** run before any app module — it hides `<html>` until
session + profile checks pass, and redirects unauthorised users to
`auth.html` / `onboarding.html`. It detects the auth/onboarding/callback
pages by URL and no-ops there.

Globals each module exposes:

- `window.PREDICTABLE_CONFIG`, `window.SUPABASE_CONFIG` — `config.js`
- `window.supabaseClient`, `window.supabaseHelpers` — `supabase-client.js`
- `window.currentUser`, `window.currentProfile` — set by `auth-guard.js`
  after a successful gate
- `window.uiHelpers` — `{ toast, setButtonLoading, showErrorInline,
  getMultiSelectValues, csv }`
- `window.api` — single wrapper over the Apps Script backend
- `window.icpBuilder`, `window.predictable.currentICP` — ICP state
  shared with Apollo Sequences page

### Backend topology

There is no first-party server. The frontend talks to three external
backends:

1. **Supabase** (`yskaojvuhaqfmimwmvbi.supabase.co`) — auth + `profiles`
   table. The anon key in `js/config.js` is **public by design**, gated by
   RLS. Do **not** add the service_role key to the client — it belongs only
   in server-side code.
2. **Google Apps Script** (`APPS_SCRIPT_URL` in `config.js`) — the "backend"
   for ICP, Apollo searches, sequence enrolment, meeting state, SDR reports.
   All calls go through `api.call(action, payload)` in `js/api.js`.
   - **Do not switch** `Content-Type` from `text/plain;charset=utf-8` to
     `application/json`. The plain text type is **intentional** — it avoids
     a CORS preflight that Apps Script cannot answer. Body is still
     JSON-stringified.
   - The wrapper aborts after `REQUEST_TIMEOUT_MS` (default 60s) and
     unwraps `{ ok, data, error }`.
3. **Cloudflare Worker** (`WORKER_URL` in `config.js`,
   `predictable-coach-proxy.aaron-78b.workers.dev`) — used only by
   `realtime-coach.js`. Issues short-lived **Deepgram grant tokens** via
   `GET /deepgram-token` (browser connects directly to Deepgram over WS with
   that token — no relay) and proxies LLM calls (`gpt-4o-mini` by default).

### Auth + onboarding flow

`auth.html` → Supabase sign-in/sign-up → `auth-callback.html`
(`detectSessionInUrl: true`, PKCE) → `supabaseHelpers.getMyProfile()` → if
`!profile.onboarded || !profile.linkedin_company_url` go to
`onboarding.html`, else `index.html`. `auth-guard.js` enforces the same
gate on every load of `index.html` and listens for `SIGNED_OUT` across
tabs.

### ICP → Apollo → Sequence flow (main app)

1. User fills the ICP form on `#page-pro-icp`. `icp-builder.js` reads
   anything with `data-icp="<key>"`, debounces, and posts via
   `api.saveICP` (Apps Script writes to Google Sheets). `currentICP` is
   stashed on `window.predictable`.
2. On `#page-pro-apollo`, `apollo-sequences.js` maps ICP fields to Apollo
   filters (`buildApolloFilters`), including translating a size range like
   `"11-200"` to Apollo's discrete buckets (`["11,20","21,50","51,100",
   "101,200"]` etc — see `sizesRangeToApollo`).
3. `api.searchApolloPeople` returns `{ run_id, people }`; UI shows results,
   user selects rows, then `api.addContactsToSequence({ run_id,
   sequence_id, apollo_person_ids })` enrols them.

### Meeting coaching (two modes)

- **`meeting-coach.js`** — server-side mode: `api.startMeeting({ meeting_url
  })` launches a recall.ai-style bot via Apps Script, then polls
  `getMeetingState` every 4s, rendering transcript + LLM `coaching_event`s.
  Shows a "thinking" indicator when there are chunks but no new event yet.
- **`realtime-coach.js`** — local capture mode: gets a Deepgram token from
  the Worker, asks for `getDisplayMedia` (tab audio) + optional mic, opens a
  WebSocket directly to Deepgram, batches utterances, and calls the Worker's
  LLM endpoint every N utterances (`COACH_TRIGGER_UTTERANCES`). The tab
  **must** be shared with "Share audio" checked — code stops the stream
  otherwise.

## Editing rules specific to this repo

- Match the existing Spanish-language comments and UI copy unless asked
  otherwise.
- Don't introduce a build step / bundler / TypeScript / framework. Modules
  are plain browser JS attached to `window`.
- When adding a new module, follow the IIFE-onto-`window` pattern and add
  it to the script list in `index.html` in dependency order (after its
  dependencies, before its consumers).
- For new app-side state shared across modules, hang it off
  `window.predictable.*` (the established namespace) rather than inventing
  a new top-level global.
- New `api` actions go in `js/api.js` as a thin wrapper around `call(action,
  payload)`; the matching handler lives in the Apps Script project (not in
  this repo).
- The Supabase anon key, Apollo dev keys in `server.js`/`server.py`, and the
  Worker URL are checked-in by design. Don't "fix" them by moving to env
  vars — there is no build/env layer.
