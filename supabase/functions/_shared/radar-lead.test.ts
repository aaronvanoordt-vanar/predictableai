// deno test supabase/functions/_shared/radar-lead.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildRadarSignalBlock, isRadarMember, radarSignalOf } from "./radar-lead.ts";

const SIGNAL = {
  detector_name: "Expansión en México",
  detector_kind: "news",
  headline: "Acme abre planta en Monterrey",
  why_fit: "Va a contratar 200 personas en ventas",
  signal_date: "2026-09-28",
  evidence: [{ url: "https://news.example/acme", summary: "Acme invierte 40 MDD en Monterrey", published_at: "2026-09-28" }],
};

Deno.test("isRadarMember: por source o por la copia del snapshot", () => {
  assert(isRadarMember({ source: { kind: "radar", signal_id: "x" } }));
  assert(isRadarMember({ source: { kind: "radar" } }));
  assert(isRadarMember({ snapshot: { radar: { signal_headline: "Algo pasó" } } }));
  assert(!isRadarMember({ source: { kind: "search" }, snapshot: {} }));
  assert(!isRadarMember(null));
});

Deno.test("radarSignalOf: la fila de radar_signals manda sobre el snapshot", () => {
  const member = { source: { kind: "radar", signal_id: "s1" }, snapshot: { radar: { signal_headline: "Viejo", why_fit: "viejo" } } };
  const sig = radarSignalOf(member, SIGNAL)!;
  assertEquals(sig.headline, "Acme abre planta en Monterrey");
  assertEquals(sig.detector_name, "Expansión en México");
  assertEquals(sig.evidence.length, 1);
});

Deno.test("radarSignalOf: sin fila usa el snapshot (investigación puntual o señal borrada)", () => {
  const member = { source: { kind: "radar" }, snapshot: { radar: { signal_headline: "Acme levantó Serie B", why_fit: "Crece rápido", evidence: [{ url: "https://x.example", summary: "Ronda de 20 MDD" }] } } };
  const sig = radarSignalOf(member, null, "Financiamiento LATAM")!;
  assertEquals(sig.headline, "Acme levantó Serie B");
  assertEquals(sig.detector_name, "Financiamiento LATAM");
  assertEquals(sig.evidence[0].summary, "Ronda de 20 MDD");
});

Deno.test("radarSignalOf: sin titular no hay señal (nunca inventa)", () => {
  assertEquals(radarSignalOf({ source: { kind: "radar" }, snapshot: {} }, null), null);
  assertEquals(radarSignalOf({ source: { kind: "search" } }, null), null);
});

Deno.test("buildRadarSignalBlock: gancho principal vs. contexto", () => {
  const sig = radarSignalOf({ source: { kind: "radar" } }, SIGNAL)!;
  const primary = buildRadarSignalBlock(sig, true);
  assert(primary.includes("Acme abre planta en Monterrey"));
  assert(primary.includes("gancho principal"));
  const ctx = buildRadarSignalBlock(sig, false);
  assert(ctx.includes("Úsala solo si ayuda"));
  assertEquals(buildRadarSignalBlock(null, true), "");
});
