// deno test --allow-read supabase/functions/_shared/suppression.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildRows, contactKeys, domainCandidates, entryMatches, guessKind, isOptOutText, isSuppressed, normDomain, normEmail,
  normLinkedin, normPhone, normalizeEntry, pickSuppression, recordOptOut, REGISTRIES, samePhone, suppressedMembers,
  type SuppressionEntry, suppressionReason,
} from "./suppression.ts";

const e = (over: Partial<SuppressionEntry>): SuppressionEntry => ({
  kind: "email", value: "ana@acme.com", channel: "all", source: "manual", legal_basis: "user_policy",
  created_at: "2026-10-01T12:00:00Z", revoked_at: null, ...over,
});

Deno.test("normaliza emails, dominios, LinkedIn y teléfonos", () => {
  assertEquals(normEmail("  Ana@ACME.com "), "ana@acme.com");
  assertEquals(normEmail("mailto:ana@acme.com"), "ana@acme.com");
  assertEquals(normEmail("ana@"), "");
  assertEquals(normDomain("https://www.Acme.com.mx/contacto?x=1"), "acme.com.mx");
  assertEquals(normDomain("@acme.com"), "acme.com");
  assertEquals(normDomain("acme"), "");
  assertEquals(normLinkedin("https://www.linkedin.com/in/Ana-Perez/?trk=x"), "ana-perez");
  assertEquals(normLinkedin("hola mundo"), "");
  // México: 521 (celular en WhatsApp) = 52; Argentina: 549 = 54; 00 y 0 de troncal fuera.
  assertEquals(normPhone("+52 1 55 1234 5678"), "525512345678");
  assertEquals(normPhone("0054 9 11 4444 5555"), "541144445555");
  assertEquals(normPhone("011 4444 5555"), "1144445555");
  assertEquals(normPhone("1234"), "");
});

Deno.test("mismo número con y sin código de país", () => {
  assert(samePhone("+52 55 1234 5678", "5512345678"));
  assert(samePhone("5215512345678", "+52 55 1234 5678"));
  assert(samePhone("+54 9 11 4444-5555", "011 4444 5555"));
  assert(samePhone("+56 9 8765 4321", "987654321"));
  assert(!samePhone("+52 55 1234 5678", "+52 55 1234 5679"));
  assert(!samePhone("12345678", "")); // sin número no hay coincidencia
});

Deno.test("adivina el tipo de un valor de CSV", () => {
  assertEquals(guessKind("ana@acme.com"), "email");
  assertEquals(guessKind("@acme.com"), "domain");
  assertEquals(guessKind("acme.com.br"), "domain");
  assertEquals(guessKind("+55 11 98765-4321"), "phone");
  assertEquals(guessKind("linkedin.com/in/ana"), "linkedin");
  assertEquals(guessKind("hola"), null);
});

Deno.test("no se puede suprimir un dominio de correo gratuito", () => {
  assertEquals(normalizeEntry("domain", "gmail.com"), null);
  const { rows, invalid } = buildRows([{ kind: "domain", value: "gmail.com" }], ["all"], { source: "manual", legal_basis: "user_policy" });
  assertEquals(rows.length, 0);
  assert(/gratuito/.test(invalid[0].why));
});

Deno.test("buildRows respeta los canales que aplican a cada tipo", () => {
  const { rows, invalid } = buildRows(
    [{ value: "ana@acme.com" }, { value: "+52 55 1234 5678" }, { value: "acme.com" }, { value: "???" }, { value: "ana@acme.com" }],
    ["whatsapp", "phone"],
    { source: "csv", legal_basis: "user_policy" },
  );
  // El email no aplica a WhatsApp ni a llamadas; el teléfono y el dominio, sí (una fila por canal).
  assertEquals(rows.map((r) => `${r.kind}:${r.channel}`).sort(), ["domain:phone", "domain:whatsapp", "phone:phone", "phone:whatsapp"]);
  assertEquals(invalid.length, 3); // "???" y el email (dos veces) no aplican a WhatsApp ni a llamadas
  const phone = rows.find((r) => r.kind === "phone")!;
  assertEquals(phone.match_key, "12345678");
  // "Todos los canales" gana sobre los canales sueltos.
  const all = buildRows([{ value: "ana@acme.com" }], ["all", "email"], { source: "manual", legal_basis: "user_policy" });
  assertEquals(all.rows.map((r) => r.channel), ["all"]);
});

Deno.test("claves de un contacto: todas sus identidades", () => {
  const keys = contactKeys({ email: "Ana@ventas.Acme.com", phone: "+52 55 1234 5678", linkedin_url: "linkedin.com/in/ana", domain: "https://acme.com" });
  assert(keys.includes("ana@ventas.acme.com"));
  assert(keys.includes("12345678"));
  assert(keys.includes("ana"));
  assert(keys.includes("ventas.acme.com"));
  assert(keys.includes("acme.com"));
  assert(!keys.includes("com"));
  // El dominio de un correo gratuito no es una empresa.
  assert(!contactKeys({ email: "ana@gmail.com" }).includes("gmail.com"));
  assertEquals(domainCandidates("a.b.acme.com"), ["a.b.acme.com", "b.acme.com", "acme.com"]);
});

Deno.test("una entrada de canal solo aplica a ese canal; 'all' a todos", () => {
  const c = { email: "ana@acme.com", phone: "5512345678" };
  const wa = e({ kind: "phone", value: "525512345678", channel: "whatsapp" });
  assert(entryMatches(wa, "whatsapp", c));
  assert(!entryMatches(wa, "phone", c));
  assert(!entryMatches(wa, "email", c));
  // La baja por WhatsApp (teléfono, 'all') también calla su email.
  const optOut = e({ kind: "phone", value: "525512345678", channel: "all", source: "whatsapp_button", legal_basis: "opt_out" });
  assert(entryMatches(optOut, "email", c));
  assert(entryMatches(optOut, "linkedin", c));
  // Revocada = ya no suprime.
  assert(!entryMatches({ ...optOut, revoked_at: "2026-10-02T00:00:00Z" }, "email", c));
});

Deno.test("el dominio cubre subdominios y el sitio de la empresa", () => {
  const dom = e({ kind: "domain", value: "acme.com", channel: "all" });
  assert(entryMatches(dom, "email", { email: "ana@mx.acme.com" }));
  assert(entryMatches(dom, "whatsapp", { phone: "5512345678", domain: "www.acme.com" }));
  assert(!entryMatches(dom, "email", { email: "ana@notacme.com" }));
  assert(!entryMatches(dom, "email", { email: "ana@acme.com.mx" }));
});

Deno.test("pickSuppression prefiere la baja del lead y explica el motivo", () => {
  const c = { email: "ana@acme.com", phone: "+52 55 1234 5678" };
  const hit = pickSuppression([
    e({ kind: "domain", value: "acme.com", source: "manual", reason: "Cliente actual", created_at: "2026-01-01T00:00:00Z" }),
    e({ kind: "phone", value: "525512345678", source: "whatsapp_button", legal_basis: "opt_out", created_at: "2026-10-12T00:00:00Z" }),
  ], "email", c)!;
  assertEquals(hit.source, "whatsapp_button");
  const why = suppressionReason(hit, "email");
  assert(/suprimido para email/.test(why));
  assert(/Darse de baja/.test(why));
  assert(/12 oct 2026/.test(why));
  assert(/sigue con el siguiente/.test(why));
  const reg = suppressionReason(e({ kind: "phone", value: "525512345678", source: "registry", legal_basis: "registry", evidence: { registry: "repep_mx" } }), "phone");
  assert(/REPEP/.test(reg));
  assertEquals(pickSuppression([], "email", c), null);
});

Deno.test("detecta pedidos de baja sin confundir respuestas normales", () => {
  for (const t of [
    "BAJA", "Stop", "No me escribas más por favor", "Por favor no me contacten", "Dejen de escribirme",
    "Quiero darme de baja", "Sáquenme de su lista", "Please unsubscribe me", "Do not contact me again",
    "Não me mande mais mensagens", "No me vuelvan a llamar",
  ]) assert(isOptOutText(t), t);
  for (const t of [
    "Baja el precio y hablamos", "Cancelar la reunión de mañana", "No me interesa por ahora", "Hola, no me llamaron ayer",
    "No me escribiste el precio", "", "Gracias!\n> Para darte de baja responde BAJA",
  ]) assert(!isOptOutText(t), t);
});

// ── Con base de datos simulada ──────────────────────────────────────────────

function fakeDb(rows: SuppressionEntry[], opts: { error?: { message: string; code?: string } } = {}) {
  const calls: { table?: string; rpc?: string; args?: unknown; filters: Record<string, unknown> }[] = [];
  return {
    calls,
    from(table: string) {
      const call = { table, filters: {} as Record<string, unknown> };
      calls.push(call);
      const q = {
        select() { return q; },
        eq(k: string, v: unknown) { call.filters[k] = v; return q; },
        is(k: string, v: unknown) { call.filters[k] = v; return q; },
        in(k: string, v: unknown) { call.filters[k] = v; return q; },
        limit() {
          if (opts.error) return Promise.resolve({ data: null, error: opts.error });
          const keys = call.filters.match_key as string[];
          return Promise.resolve({ data: rows.filter((r) => keys.includes(normalizeEntry(r.kind, r.value)!.match_key)), error: null });
        },
      };
      return q;
    },
    rpc(name: string, args: { p_rows: unknown[] }) {
      calls.push({ rpc: name, args, filters: {} });
      return Promise.resolve({ data: { added: args.p_rows.length, updated: 0 }, error: null });
    },
  };
}

Deno.test("isSuppressed: suprime, deja pasar y sin tabla se comporta como antes", async () => {
  const db = fakeDb([e({ kind: "phone", value: "525512345678", channel: "phone", source: "registry", legal_basis: "registry", evidence: { registry: "repep_mx" } })]);
  const r = await isSuppressed(db, "u1", "phone", { phone: "+52 1 55 1234 5678" });
  assert(r.suppressed);
  assert(/REPEP/.test(r.reason!));
  assertEquals(db.calls[0].filters.user_id, "u1");
  assertEquals(db.calls[0].filters.revoked_at, null);
  assertEquals((await isSuppressed(db, "u1", "whatsapp", { phone: "+52 55 1234 5678" })).suppressed, false);
  assertEquals((await isSuppressed(db, "u1", "phone", {})).suppressed, false);

  const missing = await isSuppressed(fakeDb([], { error: { code: "42P01", message: "relation \"suppression_entries\" does not exist" } }), "u1", "email", { email: "a@b.com" });
  assertEquals(missing, { suppressed: false });
  const broken = await isSuppressed(fakeDb([], { error: { message: "timeout" } }), "u1", "email", { email: "a@b.com" });
  assertEquals(broken.suppressed, false);
  assertEquals(broken.error, "timeout");
});

Deno.test("suppressedMembers devuelve solo los canales suprimidos", async () => {
  const db = fakeDb([e({ kind: "email", value: "ana@acme.com", channel: "email" })]);
  const { result } = await suppressedMembers(db, "u1", [
    { id: "m1", email: "ana@acme.com", phone: "5512345678" },
    { id: "m2", email: "beto@otra.com" },
  ], ["email", "whatsapp"]);
  assertEquals(Object.keys(result), ["m1"]);
  assertEquals(Object.keys(result.m1), ["email"]);
});

Deno.test("recordOptOut suprime todas las identidades del lead en todos los canales", async () => {
  const db = fakeDb([]);
  const n = await recordOptOut(db, {
    userId: "u1", member: { id: "m1", email: "ana@acme.com", phone: "+52 55 1234 5678", linkedin_url: "linkedin.com/in/ana" },
    phone: "5215512345678", source: "whatsapp_button", channel: "whatsapp", evidence: { text: "Darse de baja", wamid: "w1" },
  });
  assertEquals(n, 3);
  const call = db.calls.find((c) => c.rpc === "suppression_upsert")!;
  const rows = (call.args as { p_rows: { kind: string; channel: string; legal_basis: string; evidence: { channel: string } }[] }).p_rows;
  assertEquals(rows.map((r) => r.kind).sort(), ["email", "linkedin", "phone"]);
  assert(rows.every((r) => r.channel === "all" && r.legal_basis === "opt_out" && r.evidence.channel === "whatsapp"));
  // Sin lead conocido: solo el número desde el que llegó.
  const db2 = fakeDb([]);
  assertEquals(await recordOptOut(db2, { userId: "u1", phone: "+57 300 123 4567", source: "reply", channel: "whatsapp" }), 1);
});

Deno.test("REGISTRIES es espejo de js/suppression.js", async () => {
  const src = await Deno.readTextFile(new URL("../../../js/suppression.js", import.meta.url));
  const block = src.slice(src.indexOf("var REGISTRIES = {"), src.indexOf("};", src.indexOf("var REGISTRIES = {")));
  const jsKeys = [...block.matchAll(/^\s{4}([a-z_]+):\s*\{/gm)].map((m) => m[1]);
  assertEquals(jsKeys.sort(), Object.keys(REGISTRIES).sort());
  for (const [k, v] of Object.entries(REGISTRIES)) {
    const line = block.split("\n").find((l) => l.trim().startsWith(k + ":")) ?? "";
    assert(line.includes(`'${v.cc}'`), `${k}: código de país`);
    assert(line.includes(`[${v.channels.map((c) => `'${c}'`).join(", ")}]`), `${k}: canales`);
    assert(line.includes(`refresh_days: ${v.refresh_days}`), `${k}: refresh_days`);
  }
});
