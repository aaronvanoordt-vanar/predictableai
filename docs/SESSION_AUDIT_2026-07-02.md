# Claude Code Session Audit — 2026-07-02

Audit of all 28 PRs, 50 commits (2026-05-22 → 2026-07-02), branch topology, and repo/Claude-config state, performed by three parallel sub-agents (GitHub PR history, git forensics, config/code health). Raw local session transcripts are not retained in cloud containers, so this audit reads the artifacts sessions left behind — which turn out to be very telling.

## Friction clusters (ranked by cost)

### 1. No verify loop → "Claude ships, I hand-patch on github.com"

**Evidence:** 25 of 50 commits (50%) are manual GitHub web-editor "Update X" commits, and they are not typos — they are whole-file replacements (720-line rewrite `8d3059d`, 682-line rewrites `d912db6`/`e414b29`, +346/−98 `24fbb4f`), consistently clustered in the hours right after PR merges. Two are literal no-ops (`887e767`, `ba0ecb0`) and one pair is an exact revert-and-reapply 2 minutes apart. Meanwhile fix-PRs chain: #6 fixes #5 (24 min later), #16/#18/#21 are three navigation fixes in two days, and Claude direct-committed emergency fixes to main twice (`3740e2b`, `0a151b4`).

**Root cause:** sessions had nothing to run — no tests, no lint, no CI, no documented way to launch the app — so they merged unverified code, and the only correction loop available was pasting Claude.ai-chat output into the web editor.

### 2. The `index.html` monolith (6,205 lines) is structurally fragile

**Evidence:** 27 edits (most-churned file by far). Two production outage classes came directly from its shape: orphan code left by a rewrite caused a hard `SyntaxError` that silently killed every inline function and all sidebar navigation (#18), and two missing `</div>` made sibling pages parse as hidden children → black screen (`0a151b4`). All CSS + all views + ~100 inline functions in one file also blows session context and collides with manual web edits.

### 3. Rework churn: the same surfaces rebuilt over and over

- **Onboarding rebuilt ~7 times** (PR #2/#3 → #10 → #12 → #13 → #14 → #15 → #17 → #19/#20 → #27), including same-day reversals (#17 undid #14 forty minutes later, with a migration undoing schema) and two sessions editing the same step 74 seconds apart (#14 vs #15).
- **Full app re-themed 4 times** (#7 Geist dark → #23 Hub redesign → #26 light premium → #27 dark mode again, 27 minutes later). #26's body admits "antes había 3 paletas distintas en conflicto".
- **Roles/permissions across 5 PRs with a reversal and a vuln** (#9 hides Reportes → #22 unhides → #24 → #25 patches critical hole → #27 adds a client-side role switcher that tensions with #25's anti-escalation trigger).

**Root cause:** CLAUDE.md contained zero project information (only gstack install notes), so every session re-derived the product from scratch, and nothing recorded prior decisions — sessions happily reversed each other.

### 4. Fake demo data added, then purged wholesale

Fake KPIs, a fictional SDR team, the "Lucía Bermejo" brief, fake badges, hardcoded "Bienvenido, Aarón · Semana 15 · Q2 2026" — shipped by #7/#8/#22/#23, purged by #27/#28 (−402 lines). PR #27's stated goal — "que el producto se sienta **diseñado, no generado**" — is a direct complaint about generated output. Mock data still lives in the dead `js/intel-hub-v2.js`.

### 5. Security debt shipped by sessions, on a repo where main == production

- **`index.html:4631` — Apollo API key hardcoded in a page publicly served by GitHub Pages.** A second, different key in `server.js:12`, the first again in `server.py:4`. All are in git history. **Rotate both keys now**; removal from the files is not enough.
- PR #25 found and fixed two criticals sessions had introduced: self-promotion to admin via unguarded RLS (→ cross-company `sales_reports` leak) and `decrement_credits` executable by `anon` with arbitrary user id.
- Process risk: prod DB migrated *before* the PR merged; edge-function redeploys tracked only as prose in PR bodies.
- Every merged PR was self-merged within minutes (fastest: 6 seconds), zero reviews, zero CI — every merge was an unreviewed production deploy.

### 6. Hygiene noise

Heredoc wrappers (`$(cat <<'EOF' … EOF )`) leaked into ~10 PR bodies (May 26–29); 3 abandoned open PRs/branches (#1, #2, #4 — #1 was itself an attempt to write a proper CLAUDE.md, never merged); 24 `claude/*` branches never deleted; three dead Intelligence Hub generations (~1,375 lines) never removed; `server.js`/`server.py` duplicate each other with different hardcoded keys; the gstack PreToolUse hook cloned and executed an unpinned third-party repo on skill invocation (including the *built-in* `/review`) and blocked skills when the install failed.

## What this PR implements

| Fix | Cluster | File |
|---|---|---|
| Real CLAUDE.md: architecture, run instructions, dead-file map, security invariants, product rules (no demo data, neutral Spanish, token-respecting styling), PR conventions | 1, 3, 4, 5, 6 | `CLAUDE.md` |
| `/preflight` skill: smoke checks + browser drive + data-honesty + security checklist before any PR | 1, 4, 5 | `.claude/skills/preflight/SKILL.md` |
| Smoke-check script: compiles every inline `<script>` block, checks `<div>` balance, scans for new hardcoded secrets | 1, 2, 5 | `scripts/check.mjs` |
| PostToolUse hook: auto-runs the smoke check on every Edit/Write to `.html`/`.js`, feeding failures back to the session immediately | 1, 2 | `.claude/hooks/post-edit-check.sh`, `.claude/settings.json` |
| CI on every PR and push to main (first CI in the repo) | 1, 5 | `.github/workflows/ci.yml` |
| Removed gstack hook (supply-chain risk, `/review` collision, skill-blocking failure mode) and gstack-only CLAUDE.md | 6 | deleted `.claude/hooks/check-gstack.sh` |
| `.gitignore` (repo had none) | 6 | `.gitignore` |

## Proposed next steps (not in this PR — each is a good future session)

1. **URGENT: rotate both Apollo API keys** (they are public), then move Apollo calls behind a Supabase edge function so no key ships to the client; delete `server.js` or `server.py` (keep one, read the key from env).
2. **Delete dead code:** `js/intel-hub.js`, `js/intel-hub-v2.js`, `js/intel-hub-real-data.js` and their dead containers in `index.html` (~1,375 lines that confuse every session).
3. **Split `index.html`:** extract the inline Apollo integration and settings/auth blocks into `js/` modules, and the `<style>` block into a CSS file with named design tokens. This attacks cluster 2 and 3 at the root.
4. **Close/delete stale PRs #1, #2, #4** and enable GitHub's "automatically delete head branches".
5. **Decision log:** add a short `docs/DECISIONS.md` (onboarding is 2 steps; SDRs see Reportes; light+dark themes via tokens; no loading theatrics) so sessions stop reversing settled choices — seeded from cluster 3.
6. **Playwright smoke test in CI:** boot `server.py`, load `index.html`, click 3 nav items, fail on console errors — automates the exact class of bug behind #16/#18/#21.
7. **A `/db-change` skill** encoding the migration/edge-function deploy workflow, or a GitHub Action that applies migrations on merge, so "pendiente de deploy" stops living in PR prose.
