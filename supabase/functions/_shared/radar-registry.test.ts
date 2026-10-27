// deno test --allow-read --allow-env _shared/radar-registry.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { KIND_META, normalizeDetector, PLAN_JSON_SPEC } from "./radar-plan.ts";
import { RADAR_RECIPES } from "./radar-recipes.ts";
import { runTick, type DetectorRow, type TickContext } from "./radar-detectors.ts";
import type { SellerContext } from "./radar-context.ts";
import { kindAvailable } from "./radar-planner.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

Deno.test("public_registry: config acotada y siempre válida", () => {
  const d = normalizeDetector({
    kind: "public_registry", name: "Nuevas",
    config: { event: "inventado", window_days: 45, industries: ["restaurants", "no existe"], activity_codes: ["56.11", "x"], sizes: ["micro", "gigante"], require_contact: "fax" },
  })!;
  assertEquals(d.config.event, "new_companies");
  assertEquals(d.config.window_days, 60);
  assertEquals(d.config.industries, ["restaurants"]);
  assertEquals(d.config.activity_codes, ["5611"]);
  assertEquals(d.config.sizes, ["micro"]);
  assertEquals(d.config.require_contact, "");
  assertEquals(d.cadence_hours, 168);
  assertEquals(KIND_META.public_registry.requires, ["registry"]);
  assert(PLAN_JSON_SPEC.includes("public_registry:"));
});

Deno.test("las recetas de registros validan y dependen de un país con registro", () => {
  const regs = RADAR_RECIPES.filter((r) => r.kind === "public_registry");
  assert(regs.length >= 3);
  for (const r of regs) assert(normalizeDetector({ kind: r.kind, name: r.name, config: r.config }), r.id);
  const av = { llm_web: true, apollo: true, apollo_user: true, places: true, probe: true, registry: false };
  assert(!kindAvailable("public_registry", av));
  assert(kindAvailable("public_registry", { ...av, registry: true }));
});

// ── tick contra un datos.gov.co simulado ────────────────────────────────────

function ctx(): SellerContext {
  return {
    text: "", intake: {}, brief: {}, profile: {}, companyName: "Vendedor", ownDomain: "vendedor.com",
    competitorNames: [], excludedNames: [], excludedDomains: [],
    targets: { countries: ["Colombia"], industries: ["computer software"], employeeRanges: [], titles: [], seniorities: [], departments: [] },
    hash: "x",
  };
}

/** Supabase mínimo para registry_observations (select … in, upsert). */
function fakeSupa(store: Map<string, Json>) {
  return {
    from(_table: string) {
      return {
        select() {
          const q = { eq: () => q, in: (_c: string, ids: string[]) => Promise.resolve({ data: ids.map((id) => store.get(id)).filter(Boolean), error: null }) };
          return q;
        },
        upsert(rows: Json[]) { rows.forEach((r) => store.set(r.registry_id, r)); return Promise.resolve({ error: null }); },
      };
    },
  };
}

const RECENT = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);

function rues(matricula: string, ciiu: string, fecha = RECENT.replace(/-/g, "")) {
  return {
    codigo_camara: "04", camara_comercio: "BOGOTA", matricula, razon_social: `EMPRESA ${matricula} SAS`,
    numero_identificacion: "9001234" + matricula.slice(-2), estado_matricula: "ACTIVA", fecha_matricula: fecha, cod_ciiu_act_econ_pri: ciiu,
  };
}

async function withFetch<T>(rows: Json[], fn: (urls: string[]) => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    const body = url.includes("$limit=1&") ? [rues("00000001", "6201")] : rows;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
  try { return await fn(urls); } finally { globalThis.fetch = orig; }
}

function tick(det: Partial<DetectorRow>, store: Map<string, Json>): Promise<Json> {
  const detector: DetectorRow = { id: "det-1", user_id: "u", kind: "public_registry", name: "Registro", config: {}, cursor: {}, weight: 60, ...det };
  const t: TickContext = {
    supa: fakeSupa(store), detector, ctx: ctx(), countries: ["Colombia"], apollo: null, engine: "claude" as TickContext["engine"],
    knownNames: [], log: () => {},
  };
  return runTick(t);
}

Deno.test("recién constituidas: filtro de fecha en origen, candidato con la ficha y sin decision makers sin dominio", async () => {
  await withFetch([rues("00000101", "6201")], async (urls) => {
    const r = await tick({ config: { event: "new_companies", window_days: 30 } }, new Map());
    assertEquals(r.candidates.length, 1);
    const c = r.candidates[0];
    assertEquals(c.country, "Colombia");
    assert(c.headline.startsWith("Matriculada el " + RECENT), c.headline);
    assertEquals(c.industry, "computer software");
    assertEquals(c.decision_makers, []);
    assertEquals(c.facts.registry.tax_id, "900123401");
    assert(r.done);
    const search = new URL(urls[urls.length - 1]).searchParams.get("$where") || "";
    assert(search.includes("starts_with(cod_ciiu_act_econ_pri, '62')"), search);
    assert(/fecha_matricula >= '\d{8}'/.test(search), search); // la columna de prueba es texto YYYYMMDD
  });
});

Deno.test("cambio de actividad: la primera corrida es línea base, la segunda emite el cambio", async () => {
  const store = new Map<string, Json>();
  await withFetch([rues("00000201", "6201"), rues("00000202", "6202")], async () => {
    const r1 = await tick({ config: { event: "activity_change" } }, store);
    assertEquals(r1.candidates.length, 0);
    assertEquals(store.size, 2);
  });
  await withFetch([rues("00000201", "6201"), rues("00000202", "6311")], async () => {
    const r2 = await tick({ config: { event: "activity_change" } }, store);
    assertEquals(r2.candidates.length, 1);
    assertEquals(r2.candidates[0].headline, "Cambió de actividad: CIIU 6202 → 6311");
  });
});

Deno.test("sin país con registro: el detector queda 'no está configurado'", async () => {
  const detector: DetectorRow = { id: "d", user_id: "u", kind: "public_registry", name: "R", config: {}, cursor: {}, weight: 60 };
  let msg = "";
  try {
    await runTick({ supa: {}, detector, ctx: ctx(), countries: ["Bolivia"], apollo: null, engine: "claude" as TickContext["engine"], knownNames: [], log: () => {} });
  } catch (e) { msg = (e as Error).message; }
  assert(/no está configurad/.test(msg), msg);
});
