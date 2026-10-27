#!/usr/bin/env node
/**
 * scripts/registry-import/import.mjs — importa a registry_companies el
 * registro de empresas de un país que solo se publica como archivo.
 *
 *   node scripts/registry-import/import.mjs --registry rns [--url <archivo>] [--dry-run] [--limit 50000]
 *
 * Lo corre el workflow «Import Company Registry»
 * (.github/workflows/import-registry.yml), a mano para cargar o refrescar un
 * país, y en modo --dry-run en cada PR que toca esta carpeta: descarga el
 * archivo real, lee su encabezado, mapea y muestra muestras y conteos sin
 * escribir nada.
 *
 * Carga: POST /rest/v1/rpc/registry_import_batch con la service role (lotes
 * de 500). La service role sale de SUPABASE_SERVICE_ROLE_KEY o, si no está,
 * de la API de administración con SUPABASE_ACCESS_TOKEN (el mismo secret de
 * deploy-functions.yml). Cada corrida queda en registry_imports.
 *
 * Requiere Node 20+ y `unzip` en el PATH. Mapeo y fuentes en map.mjs.
 */

import { closeSync, createReadStream, createWriteStream, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createRowParser, detectDelimiter, finishRow, looksLikeHeader, resolveColumns, rowObject, SOURCES, sourcesFor,
} from "./map.mjs";

// ── argumentos ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def = "") {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : "true";
}
const REGISTRY = arg("registry");
const URL_OVERRIDE = arg("url");
const DRY = arg("dry-run", "false") === "true";
const LIMIT = Number(arg("limit", "0")) || 0;
const BATCH = 500;
const PROJECT_REF = process.env.PROJECT_REF || "yskaojvuhaqfmimwmvbi";
const UA = "PredictableAI-registry-import/1.0 (+https://predictableai.vanarsi.com)";

const keys = sourcesFor(REGISTRY);
if (!keys.length) {
  console.error(`::error::Registro desconocido: "${REGISTRY}". Usa uno de: ${[...new Set(Object.values(SOURCES).map((s) => s.registry))].join(", ")}`);
  process.exit(1);
}

// ── red ─────────────────────────────────────────────────────────────────────
/**
 * fetch con el motivo real del fallo de red (TLS, DNS, conexión) en vez de un
 * "fetch failed" a secas, y hasta 4 intentos ante un corte o un 5xx/429: los
 * portales públicos (catalogodatos.gub.uy, por ejemplo) se caen a ratos.
 */
async function fetchWhy(url, init) {
  for (let attempt = 1; ; attempt++) {
    let res = null, err = null;
    try { res = await fetch(url, init); } catch (e) { err = e; }
    const transient = err || (res && (res.status >= 500 || res.status === 429));
    if (!transient || attempt >= 4) {
      if (err) {
        const c = err?.cause;
        throw new Error(`${url} → ${err.message}${c ? ` (${c.code || ""} ${c.message || c})` : ""}`);
      }
      return res;
    }
    console.log(`  ${url} → ${err ? "sin respuesta" : "HTTP " + res.status}; reintento ${attempt}/3 en ${5 * attempt} s`);
    try { await res?.body?.cancel(); } catch { /* nada que liberar */ }
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
}

async function getText(url) {
  const res = await fetchWhy(url, { headers: { "User-Agent": UA, Accept: "*/*" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

async function getJson(url) {
  const t = await getText(url);
  try { return JSON.parse(t); } catch { throw new Error(`${url} → no es JSON: ${t.slice(0, 120)}`); }
}

function absolute(href, base) {
  try { return new URL(href, base).toString(); } catch { return ""; }
}

/** URLs de los archivos de datos de una fuente (y de su archivo auxiliar, si tiene). */
async function discover(src) {
  if (URL_OVERRIDE) return { files: [{ url: URL_OVERRIDE, name: URL_OVERRIDE.split("/").pop(), updated: "" }], aux: [] };
  const d = src.discover;
  let found = [];
  if (d.type === "fixed") found = d.urls.map((u) => ({ url: u, name: u.split("/").pop(), updated: "" }));
  if (d.type === "ckan" || d.type === "ckan_search") {
    const pkgs = d.type === "ckan"
      ? [(await getJson(`${d.base}/api/3/action/package_show?id=${encodeURIComponent(d.package)}`)).result]
      : ((await getJson(`${d.base}/api/3/action/package_search?q=${encodeURIComponent(d.q)}&rows=60`)).result?.results || []);
    for (const p of pkgs) {
      for (const r of p?.resources || []) {
        const url = r.url || "";
        found.push({ url, name: `${p.name}/${r.name || url.split("/").pop()}`, updated: (r.last_modified || r.metadata_modified || r.created || "").slice(0, 10) });
      }
    }
  }
  if (d.type === "page") {
    const html = await getText(d.url);
    const all = [...new Set([...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => absolute(m[1], d.url)).filter(Boolean))];
    found = all.filter((u) => d.link.test(u)).map((u) => ({ url: u, name: u.split("/").pop(), updated: "" }));
    if (!found.length && d.fallback) {
      console.log(`La página ${d.url} no enlaza archivos ahora: uso las ${d.fallback.length} direcciones conocidas.`);
      found = d.fallback.map((u) => ({ url: u, name: u.split("/").pop(), updated: "", optional: true }));
    } else if (!found.length) {
      console.log(`La página ${d.url} (${html.length} caracteres) no enlaza archivos de datos. Enlaces que sí tiene:`);
      all.slice(0, 80).forEach((u) => console.log(`  · ${u}`));
    }
  }
  let files = found.filter((f) => f.url && (src.pick.test(f.url) || src.pick.test(f.name)) && !(src.skip && (src.skip.test(f.url) || src.skip.test(f.name))));
  if (!files.length) {
    console.log("Recursos encontrados (ninguno calza con el filtro):");
    found.slice(0, 40).forEach((f) => console.log(`  - ${f.name} → ${f.url}`));
    throw new Error(`no encontré archivos de datos para ${src.title}. Pasa --url con el enlace del archivo.`);
  }
  files.sort((a, b) => (a.updated || a.name).localeCompare(b.updated || b.name)); // lo más nuevo al final: gana en el upsert
  if (src.latestOnly) files = files.slice(-1);
  const aux = src.aux ? found.filter((f) => src.aux.pick.test(f.url) || src.aux.pick.test(f.name)) : [];
  return { files, aux };
}

async function download(url, dir) {
  const res = await fetchWhy(url, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${url} → HTTP ${res.status}`);
  const file = join(dir, "data-" + Date.now() + "-" + (url.split("/").pop() || "f").replace(/[^\w.-]/g, "_").slice(0, 80));
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const head = Buffer.alloc(4);
  const fd = openSync(file, "r");
  readSync(fd, head, 0, 4, 0);
  closeSync(fd);
  return { file, zip: head[0] === 0x50 && head[1] === 0x4b, size: statSync(file).size };
}

/** Flujos de texto de un archivo descargado: cada CSV/TXT de un ZIP, o el archivo mismo. */
function* entries(dl) {
  if (!dl.zip) { yield { name: dl.file.split("/").pop(), open: () => createReadStream(dl.file) }; return; }
  const list = execFileSync("unzip", ["-Z1", dl.file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
  for (const name of list) {
    if (!/\.(csv|txt|tsv)$/i.test(name) || /__MACOSX/.test(name)) continue;
    yield { name, open: () => spawn("unzip", ["-p", dl.file, name], { stdio: ["ignore", "pipe", "inherit"] }).stdout };
  }
}

/** UTF-8 si los primeros 256 KB lo son; si no, Latin-1 (SUNAT, DGII, SII). */
async function sniffEncoding(open) {
  const stream = open();
  const chunks = [];
  let n = 0;
  for await (const c of stream) { chunks.push(c); n += c.length; if (n >= 262144) break; }
  stream.destroy?.();
  const buf = Buffer.concat(chunks).subarray(0, 262144);
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, Math.max(0, buf.length - 4))); return "utf-8"; } catch { return "latin1"; }
}

// ── carga ───────────────────────────────────────────────────────────────────
let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BASE = process.env.SUPABASE_URL || `https://${PROJECT_REF}.supabase.co`;

async function resolveServiceKey() {
  if (serviceKey) return serviceKey;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("falta SUPABASE_SERVICE_ROLE_KEY o SUPABASE_ACCESS_TOKEN para escribir en la base.");
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API de administración → HTTP ${res.status}`);
  const list = await res.json();
  const k = (Array.isArray(list) ? list : []).find((x) => x.name === "service_role" || x.id === "service_role");
  if (!k?.api_key) throw new Error("la API de administración no devolvió la service role.");
  serviceKey = k.api_key;
  return serviceKey;
}

async function rest(path, method, body, prefer = "") {
  const key = await resolveServiceKey();
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE}/rest/v1/${path}`, {
      method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if (attempt < 4 && (res.status >= 500 || res.status === 429)) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

// ── lectura de un archivo ───────────────────────────────────────────────────
/** Recorre cada CSV/TXT de un archivo descargado y entrega sus filas (arreglos de celdas). */
async function eachRows(dl, onEntry, onCells, shouldStop) {
  for (const entry of entries(dl)) {
    if (shouldStop()) break;
    const enc = await sniffEncoding(entry.open);
    const decoder = new TextDecoder(enc === "latin1" ? "latin1" : "utf-8");
    let parser = null, buffered = "", delim = ",";
    const stream = entry.open();
    onEntry(entry.name, enc, () => delim);
    for await (const chunk of stream) {
      let text = decoder.decode(chunk, { stream: true });
      if (!parser) {
        buffered += text;
        const nl = buffered.indexOf("\n");
        if (nl < 0 && buffered.length < 65536) continue;
        delim = detectDelimiter(buffered.slice(0, nl < 0 ? buffered.length : nl));
        // DGII, SUNAT y DNIT usan | sin comillas: un " suelto en una razón social no debe abrir un campo.
        parser = createRowParser(delim, onCells, { quotes: delim !== "|" });
        text = buffered; buffered = "";
      }
      parser.push(text);
      if (await onChunkDone()) { stream.destroy?.(); break; }
    }
    if (parser) { parser.push(decoder.decode()); parser.end(); }
    await onEntryDone();
  }
  // Ganchos opcionales que define quien llama (lotes, tope de filas).
  async function onChunkDone() { return eachRows.chunkHook ? await eachRows.chunkHook() : false; }
  async function onEntryDone() { if (eachRows.entryHook) await eachRows.entryHook(); }
}

/** Archivo auxiliar (Chile: actividades por RUT) → Map clave → valor. */
async function loadAux(src, auxFiles, dir) {
  const map = new Map();
  for (const f of auxFiles) {
    const dl = await download(f.url, dir);
    console.log(`Auxiliar ${f.name}: ${(dl.size / 1e6).toFixed(1)} MB`);
    let cols = null;
    eachRows.chunkHook = null; eachRows.entryHook = null;
    await eachRows(dl, (name, enc) => { cols = null; console.log(`  ${name} (${enc})`); }, (cells) => {
      if (!cols) {
        cols = resolveColumns(cells, src.aux.fields);
        console.log(`  Encabezado: ${cells.join(" | ").slice(0, 600)}`);
        const missing = src.aux.required.filter((k) => cols[k] < 0);
        if (missing.length) throw new Error(`al auxiliar le faltan columnas (${missing.join(", ")}): agrega el alias en map.mjs.`);
        return;
      }
      const r = rowObject(cells, cols);
      const k = src.aux.key(r), v = src.aux.value(r);
      if (!k || !v) return;
      const prev = map.get(k);
      if (!prev || (v.primary && !prev.primary)) map.set(k, v);
    }, () => false);
    rmSync(dl.file, { force: true });
  }
  console.log(`  ${map.size} claves en el auxiliar`);
  return map;
}

// ── corrida ─────────────────────────────────────────────────────────────────
async function importSource(key, dir, stats) {
  const src = SOURCES[key];
  console.log(`\n=== ${src.title} (${key} → ${src.registry}) ===`);
  const { files, aux } = await discover(src);
  console.log(`Archivos: ${files.length}`);
  files.forEach((f) => console.log(`  - ${f.name}${f.updated ? " (" + f.updated + ")" : ""} → ${f.url}`));
  const ctx = { seen: key === "sii" ? new Map() : null, cells: null, aux: null };
  if (src.aux) {
    if (aux.length) ctx.aux = await loadAux(src, aux, dir);
    else console.log("Sin archivo auxiliar: la actividad queda como texto.");
  }
  // El tope de filas (modo prueba) es por fuente: así Chile prueba el SII y el Registro de Empresas.
  const base = stats.upserted + stats.mapped;
  const full = () => !!(LIMIT && stats.upserted + stats.mapped - base >= LIMIT);
  const sampleStart = stats.samples.length;

  for (const f of files) {
    if (full()) break;
    let dl;
    try {
      dl = await download(f.url, dir);
    } catch (e) {
      // Una dirección conocida que ya no existe (p. ej. una provincia renombrada) no tumba la importación entera.
      if (f.optional && /HTTP 404/.test(e.message)) { console.log(`  Sin archivo en ${f.url} (404): sigo.`); continue; }
      throw e;
    }
    if (f.updated && f.updated > stats.dataDate) stats.dataDate = f.updated;
    console.log(`Descargado ${f.name}: ${(dl.size / 1e6).toFixed(1)} MB${dl.zip ? " (zip)" : ""}`);
    let cols = null, header = null, batch = [], entryName = "", entryEnc = "", getDelim = () => ",";
    const flush = async () => {
      if (!batch.length) return;
      const rows = batch; batch = [];
      if (DRY) { stats.mapped += rows.length; return; }
      const n = await rest("rpc/registry_import_batch", "POST", { rows });
      stats.upserted += Number(n) || 0;
    };
    eachRows.chunkHook = async () => {
      if (batch.length >= BATCH) await flush();
      return !!(LIMIT && stats.upserted + stats.mapped + batch.length - base >= LIMIT);
    };
    eachRows.entryHook = async () => {
      await flush();
      console.log(`${entryName}: ${stats.read} filas leídas hasta ahora, ${stats.skipped} descartadas, ${DRY ? stats.mapped + " mapeadas" : stats.upserted + " cargadas"}`);
    };
    await eachRows(dl, (name, enc, d) => { cols = null; entryName = name; entryEnc = enc; getDelim = d; }, (cells) => {
      stats.read++;
      if (!cols) {
        if (src.columns && !looksLikeHeader(cells, src.fields)) {
          header = src.columns;
          cols = resolveColumns(header, src.fields);
          console.log(`${entryName} sin encabezado (${entryEnc}, separador ${JSON.stringify(getDelim())}): posiciones ${src.columns.join("|")}`);
          console.log(`Primera fila: ${cells.join(" | ").slice(0, 600)}`);
        } else {
          header = cells;
          cols = resolveColumns(header, src.fields);
          console.log(`Encabezado de ${entryName} (${entryEnc}, separador ${JSON.stringify(getDelim())}): ${cells.join(" | ").slice(0, 900)}`);
          const missing = src.required.filter((k) => cols[k] < 0);
          if (missing.length) throw new Error(`a ${entryName} le faltan columnas obligatorias (${missing.join(", ")}). Revisa el encabezado de arriba y agrega el alias en map.mjs.`);
          console.log("Columnas usadas: " + Object.entries(cols).map(([k, i]) => `${k}=${i >= 0 ? header[i] : "—"}`).join(", "));
          stats.read--;
          return;
        }
      }
      ctx.cells = cells;
      let mapped = null;
      try { mapped = src.map(rowObject(cells, cols), ctx); } catch { mapped = null; }
      const row = finishRow(key, mapped, f.updated);
      if (!row) { stats.skipped++; return; }
      if (stats.samples.length - sampleStart < 3) stats.samples.push(row);
      batch.push(row);
    }, full);
    rmSync(dl.file, { force: true });
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  const stats = { read: 0, skipped: 0, mapped: 0, upserted: 0, samples: [], dataDate: "" };
  let importId = null;
  const registry = SOURCES[keys[0]].registry;
  try {
    if (!DRY) {
      const [row] = await rest("registry_imports", "POST", { registry, source_file: keys.join(",") + (URL_OVERRIDE ? " " + URL_OVERRIDE : ""), status: "running" }, "return=representation");
      importId = row?.id;
    }
    for (const key of keys) await importSource(key, dir, stats);
    const good = DRY ? stats.mapped : stats.upserted;
    console.log(`\nResumen ${registry}: ${stats.read} filas leídas · ${stats.skipped} descartadas (personas naturales, sucursales o sin datos) · ${good} ${DRY ? "mapeadas (no se escribió nada)" : "cargadas"}`);
    console.log("Muestras:");
    stats.samples.forEach((s) => console.log("  " + JSON.stringify(s)));
    if (!good) throw new Error("ninguna fila se pudo mapear: revisa el encabezado y el mapa.");
    if (importId) {
      await rest(`registry_imports?id=eq.${importId}`, "PATCH", {
        status: "done", rows_read: stats.read, rows_upserted: stats.upserted, rows_skipped: stats.skipped,
        // Fecha de los datos según el portal; si no la publica, la de la descarga.
        source_updated_on: stats.dataDate || new Date().toISOString().slice(0, 10), finished_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.error(`::error::${registry}: ${e.message}`);
    if (importId) {
      await rest(`registry_imports?id=eq.${importId}`, "PATCH", {
        status: "failed", detail: String(e.message).slice(0, 500), rows_read: stats.read, rows_upserted: stats.upserted, rows_skipped: stats.skipped, finished_at: new Date().toISOString(),
      }).catch(() => {});
    }
    process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
