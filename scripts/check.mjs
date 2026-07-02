#!/usr/bin/env node
// Smoke checks for predictable.ai — catches the failure classes that have
// broken production before (see docs/SESSION_AUDIT_2026-07-02.md):
//   1. SyntaxError in an inline <script> block of an HTML page (PR #18: killed all nav)
//   2. Unbalanced <div> tags (black screen on navigation, commit 0a151b4)
//   3. SyntaxError in any js/ module
//   4. New hardcoded API-key-looking secrets
// Usage: node scripts/check.mjs [file ...]   (no args = check whole repo)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative, isAbsolute } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
let failures = 0;

function fail(file, msg) {
  failures++;
  console.error(`FAIL ${relative(root, file)}: ${msg}`);
}

function listFiles(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'assets'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(p, exts, out);
    else if (exts.includes(extname(name))) out.push(p);
  }
  return out;
}

function checkJsSource(file, src, label = '') {
  try {
    new Function(src); // compile only — never executed
  } catch (e) {
    fail(file, `${label}JS syntax error: ${e.message}`);
  }
}

function checkHtml(file) {
  const src = readFileSync(file, 'utf8');
  // 1. compile every inline <script> block (skip src= and non-JS types)
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(src)) !== null) {
    i++;
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/\btype\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue;
    checkJsSource(file, m[2], `inline <script> #${i} `);
  }
  // 2. div balance (crude, but this exact bug shipped a black screen)
  const open = (src.match(/<div\b/gi) || []).length;
  const close = (src.match(/<\/div>/gi) || []).length;
  if (open !== close) fail(file, `unbalanced <div>: ${open} open vs ${close} close`);
}

function checkSecrets(file) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const grandfathered = [];
  const patterns = [
    /sk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
    /(?:api[_-]?key|apikey|secret|token)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i,
  ];
  lines.forEach((line, idx) => {
    if (grandfathered.some((k) => line.includes(k))) return;
    if (/anon[_-]?key/i.test(line)) return; // Supabase anon key is public by design (RLS enforces access)
    for (const p of patterns) {
      if (p.test(line)) fail(file, `possible hardcoded secret at line ${idx + 1}`);
    }
  });
}

const files = args.length
  ? args.map((f) => (isAbsolute(f) ? f : join(process.cwd(), f)))
  : listFiles(root, ['.html', '.js']);

for (const f of files) {
  try {
    if (extname(f) === '.html') {
      checkHtml(f);
      checkSecrets(f);
    } else if (extname(f) === '.js') {
      checkJsSource(f, readFileSync(f, 'utf8'));
      checkSecrets(f);
    }
  } catch (e) {
    fail(f, `could not check: ${e.message}`);
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`OK — ${files.length} file(s) checked.`);
