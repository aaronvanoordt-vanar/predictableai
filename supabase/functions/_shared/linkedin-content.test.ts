// deno test --allow-read _shared/linkedin-content.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  canTransition, isLinkedInPostUrl, MAX_POST_CHARS, memberAnalyticsCount, metricsUnavailableReason, normalizeDraft,
  normalizeIdeas, objectionLines, orgShareMetrics, pickApp, PILLARS, postRequestBody, postUrl, proofBlock, proofFacts,
  radarTrendBlock, toCommentary, unsupportedFigures,
} from "./linkedin-content.ts";

Deno.test("transiciones: nada se programa ni se publica sin aprobar", () => {
  assert(canTransition("idea", "draft"));
  assert(canTransition("draft", "approved"));
  assert(canTransition("approved", "scheduled"));
  assert(canTransition("approved", "published"));
  assert(canTransition("scheduled", "published"));
  assert(canTransition("scheduled", "approved"));
  assert(!canTransition("idea", "approved"));
  assert(!canTransition("draft", "scheduled"));
  assert(!canTransition("draft", "published"));
  assert(!canTransition("idea", "published"));
  assert(!canTransition("published", "draft"));
});

Deno.test("proofFacts: solo cliente + resultado, y social_proof_none gana", () => {
  const intake = {
    social_proof: [
      { client: "Acme", industry: "Retail", result: "Bajó 30% el costo por reunión" },
      { client: "Sin resultado", industry: "x", result: "" },
      { client: "", result: "Resultado sin cliente" },
    ],
    current_customers: [{ name: "Cliente que no autorizó" }],
  };
  assertEquals(proofFacts(intake), [{ client: "Acme", industry: "Retail", result: "Bajó 30% el costo por reunión" }]);
  assertEquals(proofFacts({ ...intake, social_proof_none: true }), []);
  assertEquals(proofFacts(null), []);
  assert(proofBlock([]).includes("NO menciona clientes"));
  assert(proofBlock(proofFacts(intake)).includes("Acme (Retail)"));
});

Deno.test("normalizeIdeas: sin prueba social se descartan las ideas de caso", () => {
  const raw = {
    ideas: [
      { title: "El costo oculto de no responder en 5 minutos", pillar: "dolor", angle: "a", hook: "h", based_on: [{ kind: "dolor", label: "Respuesta lenta" }] },
      { title: "Cómo Acme duplicó sus reuniones", pillar: "caso", based_on: [{ kind: "caso", label: "Acme" }] },
      { title: "Opinión disfrazada de caso", pillar: "opinion", based_on: [{ kind: "caso", label: "Acme" }] },
      { title: "el costo oculto de no responder en 5 minutos", pillar: "dolor" },
      { title: "", pillar: "dolor" },
      { title: "Pilar raro", pillar: "inventado", based_on: [{ kind: "nope", label: "x" }] },
    ],
  };
  const noProof = normalizeIdeas(raw, false);
  assertEquals(noProof.map((i) => i.title), ["El costo oculto de no responder en 5 minutos", "Pilar raro"]);
  assertEquals(noProof[1].pillar, "opinion");
  assertEquals(noProof[1].based_on, []);
  const withProof = normalizeIdeas(raw, true);
  assertEquals(withProof.length, 4);
});

Deno.test("normalizeDraft: recorta al límite de LinkedIn y limpia saltos", () => {
  assertEquals(normalizeDraft({ body: "  " }, true), null);
  const d = normalizeDraft({ body: "Hola\r\n\n\n\nmundo", based_on: [{ kind: "caso", label: "Acme" }] }, false)!;
  assertEquals(d.body, "Hola\n\nmundo");
  assertEquals(d.based_on, []);
  const long = normalizeDraft({ body: ("Una frase larga de prueba. ").repeat(200) }, true)!;
  assert(long.body.length <= MAX_POST_CHARS);
  assert(long.body.endsWith("."));
});

Deno.test("unsupportedFigures: avisa las cifras que no están en las fuentes", () => {
  const sources = "Acme: bajó 30% el costo. Ticket US$1.200. Ciclo de 45 días.";
  const body = "Bajamos 30% el costo, con ticket de $1200, en 45 días. Otro cliente creció 3x y ahorró 250 mil. En 2025 vimos 3 errores.";
  assertEquals(unsupportedFigures(body, sources), ["3x", "250 mil"]);
  assertEquals(unsupportedFigures("Sin cifras aquí.", ""), []);
  assertEquals(unsupportedFigures("El 80% de los equipos", ""), ["80%"]);
});

Deno.test("objectionLines acepta strings y objetos", () => {
  assertEquals(objectionLines({ common_objections: ["Es caro", { objection: "Ya tenemos CRM", answer: "Se conecta" }] }), ["Es caro", "Ya tenemos CRM → Se conecta"]);
  assertEquals(objectionLines({ common_objections: "Texto libre" }), ["Texto libre"]);
  assertEquals(objectionLines({}), []);
});

Deno.test("radarTrendBlock nunca nombra a la empresa", () => {
  const b = radarTrendBlock([{ company_name: "Fulano SA", headline: "Fulano SA abre 12 vacantes de SDR", why_fit: "Fulano SA crece en ventas", detector_name: "Contrataciones" }]);
  assert(!b.includes("Fulano"));
  assert(b.includes("una empresa abre 12 vacantes de SDR"));
  assertEquals(radarTrendBlock([]), "");
});

Deno.test("toCommentary: escapa reservados y convierte hashtags", () => {
  assertEquals(toCommentary("Hola (equipo) @todos"), "Hola \\(equipo\\) \\@todos");
  assertEquals(toCommentary("#Ventas y #B2B_Latam."), "{hashtag|\\#|Ventas} y {hashtag|\\#|B2B\\_Latam}.");
  assertEquals(toCommentary("C# no es hashtag"), "C\\# no es hashtag");
  assertEquals(toCommentary("Línea 1\nLínea *2*"), "Línea 1\nLínea \\*2\\*");
  assertEquals(toCommentary("#Ñandú"), "{hashtag|\\#|Ñandú}");
});

Deno.test("postRequestBody arma la petición de la Posts API", () => {
  const b = postRequestBody("urn:li:person:abc", "Hola");
  assertEquals(b.author, "urn:li:person:abc");
  assertEquals(b.commentary, "Hola");
  assertEquals(b.lifecycleState, "PUBLISHED");
  assertEquals(b.visibility, "PUBLIC");
});

Deno.test("URLs y URNs", () => {
  assertEquals(postUrl("urn:li:share:123"), "https://www.linkedin.com/feed/update/urn:li:share:123/");
  assertEquals(postUrl("urn:li:ugcPost:9"), "https://www.linkedin.com/feed/update/urn:li:ugcPost:9/");
  assertEquals(postUrl("javascript:alert(1)"), "");
  assert(isLinkedInPostUrl("https://www.linkedin.com/posts/x-123"));
  assert(!isLinkedInPostUrl("https://evil.com/linkedin.com"));
  assert(!isLinkedInPostUrl("http://www.linkedin.com/posts/x"));
  assert(!isLinkedInPostUrl("https://notlinkedin.com/x"));
});

Deno.test("métricas: solo lo que vino", () => {
  assertEquals(orgShareMetrics({ elements: [{ totalShareStatistics: { impressionCount: 120, likeCount: 4, commentCount: 1, shareCount: 0, clickCount: 7, uniqueImpressionsCount: 90 } }] }),
    { impressions: 120, reach: 90, reactions: 4, comments: 1, reshares: 0, clicks: 7 });
  assertEquals(orgShareMetrics({ elements: [] }), null);
  assertEquals(memberAnalyticsCount({ elements: [{ count: 55 }] }), 55);
  assertEquals(memberAnalyticsCount({}), null);
});

Deno.test("metricsUnavailableReason dice por qué no hay métricas", () => {
  const api = { publish_mode: "api", linkedin_post_urn: "urn:li:share:1", publish_target: "member" };
  assert(metricsUnavailableReason({ publish_mode: "manual" }, null)!.includes("a mano"));
  assert(metricsUnavailableReason(api, { app: "share", scopes: [] })!.includes("Community Management"));
  assert(metricsUnavailableReason(api, { app: "community", scopes: [] })!.includes("r_member_postAnalytics"));
  assertEquals(metricsUnavailableReason(api, { app: "community", scopes: ["r_member_postAnalytics"] }), null);
  assertEquals(metricsUnavailableReason({ ...api, publish_target: "organization" }, { app: "community", scopes: ["r_organization_social"] }), null);
});

Deno.test("pickApp prefiere Community Management", () => {
  assertEquals(pickApp({ share: true, community: true }), "community");
  assertEquals(pickApp({ share: true, community: false }), "share");
  assertEquals(pickApp({ share: false, community: false }), null);
});

Deno.test("js/linkedin-content.js espeja PILLARS", async () => {
  const js = await Deno.readTextFile(new URL("../../../js/linkedin-content.js", import.meta.url));
  const block = js.match(/var PILLARS = \{([\s\S]*?)\};/)?.[1] ?? "";
  const shown: Record<string, string> = {};
  for (const m of block.matchAll(/(\w+):\s*'([^']+)'/g)) shown[m[1]] = m[2];
  assertEquals(shown, { ...PILLARS });
});
