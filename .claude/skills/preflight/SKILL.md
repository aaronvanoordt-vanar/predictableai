---
name: preflight
description: Verify the app actually works before opening or merging a PR. Run after any change to index.html, js/, or auth/onboarding pages. Merging to main deploys straight to production (GitHub Pages), so this is the only gate.
---

# Preflight — verify before you ship

Merging to `main` deploys immediately to https://predictableai.vanarsi.com. There is no staging and no test suite, so run this checklist before creating or updating any PR.

## 1. Static smoke checks (always)

```bash
node scripts/check.mjs
```

Must print `OK`. This catches the two failure classes that have taken production down before: a SyntaxError in an inline `<script>` block of `index.html` (kills every sidebar `onclick`), and unbalanced `<div>` tags (black screen on navigation).

## 2. Drive the app in a browser (for any UI or navigation change)

Start the local server (static files + Apollo proxy on :3000):

```bash
python3 server.py &
```

Then use Playwright (Chromium is pre-installed in web sessions) to load and screenshot:

- `http://localhost:3000/index.html` — check the console for errors, click at least 3 sidebar items and confirm each page renders (no black screen), take a screenshot.
- If you touched onboarding: `onboarding.html` end to end.
- If you touched auth pages: `auth.html` renders and buttons exist (OAuth itself can't be tested locally).

A page that loads but logs `ReferenceError`/`SyntaxError` in the console is a FAILURE even if it looks fine.

## 3. Data honesty check (for any UI change)

Grep your diff for invented data before shipping — no fake metrics, fake people, fake badges, or hardcoded greetings. Empty states must be honest (this app purged all demo data in PR #28; do not reintroduce it):

```bash
git diff main | grep -inE 'lucia|bermejo|1,?247|semana 15|badge' || true
```

## 4. Security check (if you touched roles, RLS, or edge functions)

- Users must NEVER be able to change their own `profiles.role` (anti-escalation trigger from the security-hardening migration — do not add UI or RLS that bypasses it).
- Any new migration = new file under `supabase/migrations/`, never edit an old one (they are applied in production).
- Edge function changes do NOT auto-deploy — state "requires `supabase functions deploy <name>`" in the PR body.

## 5. Report

In the PR body, state exactly what you verified (which pages you drove, screenshots) and what you could not verify locally (OAuth, edge functions, Realtime).
