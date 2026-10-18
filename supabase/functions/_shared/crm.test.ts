// deno test supabase/functions/_shared/crm.test.ts --allow-read
//
// Mantiene alineados la migración del CRM (20261017100001), este módulo y el
// espejo de la UI (js/crm.js), y fija las reglas del aprendizaje de pérdidas.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  companyDomain, CURRENCIES, DEFAULT_STAGES, FREE_MAIL_DOMAINS, LOST_REASON_KEYS, LOST_REASONS, lossInsights, normDomain, normName,
} from "./crm.ts";

const root = new URL("../../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));
const SQL = read("supabase/migrations/20261017100001_crm_accounts_opportunities.sql");
const JS = read("js/crm.js");

const block = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  assert(i >= 0, `no encontré «${start}»`);
  return src.slice(i, src.indexOf(end, i + start.length));
};

Deno.test("motivos de pérdida: crm.ts = CHECK de la base = js/crm.js", () => {
  const check = block(SQL, "lost_reason IN (", "))");
  assertEquals([...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), LOST_REASON_KEYS);
  const js = block(JS, "var LOST_REASONS = [", "];");
  assertEquals([...js.matchAll(/key: '([a-z_]+)', label: '([^']+)'/g)].map((m) => [m[1], m[2]]), LOST_REASONS.map((r) => [r.key, r.label]));
});

Deno.test("monedas: crm.ts = js/crm.js", () => {
  const js = block(JS, "var CURRENCIES = [", "];");
  assertEquals([...js.matchAll(/'([A-Z]{3})'/g)].map((m) => m[1]), [...CURRENCIES]);
});

Deno.test("correos gratuitos: crm.ts = crm_is_free_mail_domain()", () => {
  const sql = block(SQL, "FUNCTION public.crm_is_free_mail_domain", "$$;");
  assertEquals([...sql.matchAll(/'([a-z0-9.]+\.[a-z]+)'/g)].map((m) => m[1]), [...FREE_MAIL_DOMAINS]);
});

Deno.test("pipeline por defecto: crm.ts = crm_seed_stages()", () => {
  const sql = block(SQL, "FUNCTION public.crm_seed_stages", "RETURN QUERY");
  const rows = [...sql.matchAll(/\(p_user, '([^']+)',\s+(\d), '(open|won|lost)',\s*(\d+), (?:'([a-z_]+)'|NULL)\)/g)]
    .map((m): { name: string; kind: string; probability: number; auto_key: string | null } => ({ name: m[1], kind: m[3], probability: Number(m[4]), auto_key: m[5] ?? null }));
  assertEquals(rows, DEFAULT_STAGES.map((s) => ({ name: s.name, kind: s.kind, probability: s.probability, auto_key: s.auto_key })));
});

Deno.test("normDomain = crm_norm_domain", () => {
  assertEquals(normDomain("https://www.Acme.com.mx/contacto?x=1"), "acme.com.mx");
  assertEquals(normDomain("acme.com:8080"), "acme.com");
  assertEquals(normDomain("HTTP://sub.Acme.co/"), "sub.acme.co");
  assertEquals(normDomain("acme.com."), "acme.com");
  assertEquals(normDomain("Acme SA"), null);
  assertEquals(normDomain("localhost"), null);
  assertEquals(normDomain(""), null);
  assertEquals(normDomain(null), null);
  assertEquals(companyDomain("https://gmail.com"), null);
  assertEquals(companyDomain("acme.com"), "acme.com");
});

Deno.test("normName = crm_norm_name", () => {
  assertEquals(normName("Acmé  S.A."), "acmesa");
  assertEquals(normName("ACME SA"), "acmesa");
  assertEquals(normName("Compañía Ñandú"), "companianandu");
  assertEquals(normName("  "), null);
});

Deno.test("aprendizaje de pérdidas: sin volumen no hay veredicto", () => {
  assertEquals(lossInsights([{ lost_reason: "precio" }, { lost_reason: "precio" }]), []);
  assertEquals(lossInsights([{ lost_reason: "inventado" }, { lost_reason: null }, { lost_reason: "precio" }]), []);
});

Deno.test("aprendizaje de pérdidas: el motivo que se repite falla, el aislado es neutro", () => {
  const rows = [
    { lost_reason: "precio" }, { lost_reason: "precio" }, { lost_reason: "precio" },
    { lost_reason: "competencia", lost_competitor: "Rival X" }, { lost_reason: "competencia", lost_competitor: "Rival  X" },
    { lost_reason: "competencia", lost_competitor: "Otro" },
    ...Array.from({ length: 9 }, (_, i) => ({ lost_reason: ["timing", "prioridad", "decisor", "sin_respuesta", "no_encaja", "interno", "presupuesto", "otro", "timing"][i], lost_note: "nota" })),
  ];
  const out = lossInsights(rows, 4);
  assertEquals(out.slice(0, 2).map((r) => r.key), ["competencia", "precio"], "empate 3-3: orden alfabético estable");
  const precio = out.find((r) => r.key === "precio")!;
  assertEquals(precio.verdict, "fails");
  assertEquals(precio.metrics.lost_total, 15);
  assertEquals(precio.metrics.won_total, 4);
  assertEquals(precio.metrics.share, 20);
  const comp = out.find((r) => r.key === "competencia")!;
  assertEquals(comp.verdict, "fails");
  assertEquals(comp.metrics.competitors[0], { name: "Rival X", count: 2 });
  assertEquals(out.find((r) => r.key === "timing")!.verdict, "neutral", "2 de 15 no llega al 20 %");
  assertEquals(out.find((r) => r.key === "decisor")!.verdict, "neutral");
  assertEquals(out.find((r) => r.key === "otro")!.metrics.notes, ["nota"]);
  assertEquals(out.find((r) => r.key === "precio")!.metrics.notes, []);
});
