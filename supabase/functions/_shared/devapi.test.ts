// deno test supabase/functions/_shared/devapi.test.ts --allow-read
//
// Mantiene alineados los cuatro lugares que describen la API para
// desarrolladores: las operaciones (devapi.ts), el contrato público
// (/openapi.json), los triggers que emiten eventos (migración
// 20260923000010) y el espejo de la UI (js/developers.js).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  CONTACT_STATUSES, EVENT_TYPES, OPERATIONS, ROUTES, hmacSha256Hex, isSafeWebhookUrl, matchRoute, signatureHeader, toolName,
} from "./devapi.ts";

const root = new URL("../../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));

Deno.test("cada ruta REST existe en openapi.json con el mismo método", () => {
  const spec = JSON.parse(read("openapi.json"));
  for (const [method, pattern] of ROUTES) {
    const path = pattern.replace(/:([a-z_]+)/g, "{$1}");
    assert(spec.paths[path], `falta ${path} en openapi.json`);
    assert(spec.paths[path][method.toLowerCase()], `falta ${method} ${path} en openapi.json`);
  }
  // Y al revés: nada documentado que no exista.
  for (const [path, methods] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
    for (const m of Object.keys(methods)) {
      const pattern = path.replace(/\{([a-z_]+)\}/g, ":$1");
      assert(ROUTES.some(([rm, rp]) => rm === m.toUpperCase() && rp === pattern), `openapi.json documenta ${m.toUpperCase()} ${path}, que no existe`);
    }
  }
});

Deno.test("cada ruta apunta a una operación existente", () => {
  for (const [, , op] of ROUTES) assert(OPERATIONS[op], `operación ${op} no existe`);
});

Deno.test("tipos de evento: devapi.ts = openapi.json = migración = js/developers.js", () => {
  const spec = JSON.parse(read("openapi.json"));
  assertEquals([...spec.components.schemas.Event.properties.type.enum].sort(), [...EVENT_TYPES].sort());
  const sql = read("supabase/migrations/20260923000010_developer_api.sql");
  const emitted = new Set([...sql.matchAll(/'((?:contact|message|signal|enrollment|meeting)\.[a-z_]+)'/g)].map((m) => m[1]));
  assertEquals([...emitted].sort(), [...EVENT_TYPES].sort());
  const js = read("js/developers.js");
  for (const e of EVENT_TYPES) assert(js.includes(`'${e}'`), `js/developers.js no lista ${e}`);
});

Deno.test("estados de contacto = CHECK de la base", () => {
  const sql = read("supabase/migrations/20260902000001_omnichannel_campaigns.sql");
  const block = sql.slice(sql.indexOf("CHECK (contact_status IN ("), sql.indexOf("));", sql.indexOf("CHECK (contact_status IN (")));
  const vals = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals([...vals].sort(), [...CONTACT_STATUSES].sort());
});

Deno.test("matchRoute resuelve rutas, parámetros y 405", () => {
  assertEquals(matchRoute("GET", "/v1/contacts"), { op: "contacts.list", params: {} });
  assertEquals(matchRoute("POST", "/v1/contacts/bulk"), { op: "contacts.bulk_upsert", params: {} });
  const id = "0b7f2f5c-1d7a-4d5e-9d0e-6a0f0d8b1c2e";
  assertEquals(matchRoute("GET", `/v1/contacts/${id}`), { op: "contacts.get", params: { contact_id: id } });
  assertEquals(matchRoute("POST", `/v1/campaigns/${id}/enrollments/`), { op: "campaigns.enroll", params: { campaign_id: id } });
  const r = matchRoute("PUT", "/v1/lists");
  assert(r && "allowed" in r && r.allowed.includes("GET") && r.allowed.includes("POST"));
  assertEquals(matchRoute("GET", "/v2/nada"), null);
});

Deno.test("nombres de herramienta MCP únicos y válidos", () => {
  const names = Object.keys(OPERATIONS).map(toolName);
  assertEquals(new Set(names).size, names.length);
  for (const n of names) assert(/^[a-zA-Z0-9_-]{1,64}$/.test(n), n);
  for (const op of Object.values(OPERATIONS)) assertEquals(op.params.type, "object");
});

Deno.test("herramientas MCP = espejo MCP_TOOLS de js/developers.js", () => {
  const js = read("js/developers.js");
  const block = js.slice(js.indexOf("var MCP_TOOLS = ["), js.indexOf("];", js.indexOf("var MCP_TOOLS = [")));
  const listed = [...block.matchAll(/\['([a-z_]+)'/g)].map((m) => m[1]).sort();
  assertEquals(listed, Object.keys(OPERATIONS).map(toolName).sort());
});

Deno.test("isSafeWebhookUrl bloquea redes internas", () => {
  assert(isSafeWebhookUrl("https://hooks.zapier.com/hooks/catch/1/abc"));
  assert(isSafeWebhookUrl("https://crm.miempresa.com:8443/predictable"));
  for (const u of [
    "http://crm.miempresa.com", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x",
    "https://192.168.1.10/x", "https://172.20.0.1/x", "https://169.254.169.254/latest", "https://[::1]/x",
    "https://user:pass@crm.com/x", "https://2130706433/x", "https://db.internal/x", "no es url",
  ]) assert(!isSafeWebhookUrl(u), u);
});

Deno.test("firma HMAC: vector conocido y formato de cabecera", async () => {
  // RFC 4231, caso 2.
  assertEquals(await hmacSha256Hex("Jefe", "what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  const h = await signatureHeader("whsec_test", '{"a":1}', 1700000000);
  assertEquals(h, `t=1700000000,v1=${await hmacSha256Hex("whsec_test", '1700000000.{"a":1}')}`);
});
