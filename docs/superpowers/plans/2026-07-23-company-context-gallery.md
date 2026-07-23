# Company Context Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the long company-context form with a responsive seven-card expandable gallery, real progress, and global/per-card AI actions.

**Architecture:** Keep the current `renderResearch` data loading, persistence, realtime updates, and enrichment endpoints. Add pure section-state helpers and render the same fields inside an accessible gallery; the seventh card summarizes AI-derived context while PDF sources move outside progress. Per-card AI actions reuse the existing enrichment pipeline and return focus to the selected card.

**Tech Stack:** Vanilla JavaScript, HTML templates, CSS custom properties, Supabase client/realtime, existing Edge Functions, Node 22 smoke checks.

## Global Constraints

- Preserve existing data and save paths.
- Use three columns on desktop, two on tablet, and one on mobile.
- Keep light/dark theme tokens and neutral Latin American Spanish.
- Do not add demo data or destructive migrations.
- Respect `prefers-reduced-motion` and keyboard interaction.

---

### Task 1: Gallery state and completion helpers

**Files:**
- Modify: `js/intel-hub-cadence-tabs.js`
- Test: `scripts/check.mjs`

**Interfaces:**
- Produces: `researchSectionState(sectionKey, intake, brief)` returning `{ complete, summary }`.
- Produces: `researchProgress(intake, brief)` returning `{ complete, percent }`.
- Consumes: current `STATE.intake` and `STATE.brief`.

- [ ] **Step 1: Add seven explicit section definitions**

Define keys `company`, `firmographics`, `pains`, `solutions`, `positioning`, `outcomes`, and `summary`, including the fields that make each section complete.

- [ ] **Step 2: Add pure completion and summary helpers**

Treat a section as complete when all required values are non-empty. Treat the summary section as complete when the six prior sections are complete. Calculate progress as `Math.round(complete / 7 * 100)`.

- [ ] **Step 3: Run the smoke check**

Run: `node scripts/check.mjs`

Expected: `OK — 31 file(s) checked.`

- [ ] **Step 4: Commit**

```bash
git add js/intel-hub-cadence-tabs.js
git commit -m "feat: calculate company context progress"
```

### Task 2: Expandable gallery markup and interaction

**Files:**
- Modify: `js/intel-hub-cadence-tabs.js`

**Interfaces:**
- Consumes: `researchSectionState` and `researchProgress`.
- Produces: `.ihx-context-gallery`, `.ihx-context-card`, and `data-research-section` interactions.

- [ ] **Step 1: Replace the stacked cards**

Render a progress header, seven compact cards, and one expanded card at a time. Keep every current form control and field name so `saveResearch` continues to persist unchanged.

- [ ] **Step 2: Add accessible interaction**

Card headers are buttons with `aria-expanded`; clicking or pressing Enter opens the card and closes the previous one. Store the open key in `STATE.researchOpenSection`.

- [ ] **Step 3: Add global and individual AI actions**

Add “Completar todo con IA” to the progress header and “Generar/Mejorar con IA” to cards 1–6. Resolve the best available source in order: LinkedIn, then the website input. Reuse existing enrichment functions and preserve the selected card across realtime rerenders.

- [ ] **Step 4: Keep PDFs outside progress**

Render document upload beneath the gallery as “Fuentes adicionales para la IA”; it does not affect the 7-step percentage.

- [ ] **Step 5: Run the smoke check**

Run: `node scripts/check.mjs`

Expected: `OK — 31 file(s) checked.`

- [ ] **Step 6: Commit**

```bash
git add js/intel-hub-cadence-tabs.js
git commit -m "feat: render expandable company context gallery"
```

### Task 3: Production-grade responsive styling

**Files:**
- Modify: `js/intel-hub-cadence-tabs.js`

**Interfaces:**
- Consumes: gallery classes created in Task 2.
- Produces: responsive, theme-aware, reduced-motion-safe styling.

- [ ] **Step 1: Add gallery layout and card styling**

Use a three-column grid above 1100px, two columns from 700–1099px, and one below 700px. Closed cards use `aspect-ratio: 1 / 1`; expanded cards span all columns and remove fixed aspect ratio.

- [ ] **Step 2: Style progress and states**

Use current blue accent tokens for the progress fill, green for completed states, red for errors, and neutral borders for pending. Keep visible keyboard focus.

- [ ] **Step 3: Add motion safeguards**

Use a short opacity/transform transition for expansion and disable it under `prefers-reduced-motion: reduce`.

- [ ] **Step 4: Run smoke and whitespace checks**

Run: `node scripts/check.mjs && git diff --check`

Expected: smoke check passes and `git diff --check` has no output.

- [ ] **Step 5: Commit**

```bash
git add js/intel-hub-cadence-tabs.js
git commit -m "style: polish company context gallery"
```

### Task 4: Browser verification and publication

**Files:**
- Verify: `index.html`
- Verify: `js/intel-hub-cadence-tabs.js`

**Interfaces:**
- Consumes: completed local implementation.
- Produces: pushed `main` branch and live GitHub Pages deployment.

- [ ] **Step 1: Serve the app locally**

Run: `python3 -m http.server 8080`

Expected: the page loads at `http://localhost:8080/index.html`.

- [ ] **Step 2: Verify responsive and interaction states**

Confirm three/two/one-column layouts, card expansion, progress semantics, keyboard focus, dark theme, save behavior, and both AI action levels.

- [ ] **Step 3: Run final automated verification**

Run: `node scripts/check.mjs && git status --short --branch`

Expected: smoke check passes; branch is ahead only by intended commits.

- [ ] **Step 4: Push**

Run: `git push origin main`

Expected: GitHub accepts all local commits and triggers CI/Pages.

- [ ] **Step 5: Confirm GitHub Actions**

Query the public Actions API for the pushed SHA and confirm CI and Pages complete successfully.
