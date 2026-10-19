// deno test --allow-read --allow-env _shared/warmup.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { appPasswordHosts, parseInstantlyStats, warmupView } from "./warmup.ts";

Deno.test("parseInstantlyStats: lee el agregado por email y calcula la salud si falta", () => {
  const m = parseInstantlyStats({ aggregate_data: { "ana@acme.com": { sent: 40, landed_inbox: 36, landed_spam: 4, received: 38 } } }, ["ana@acme.com", "otro@acme.com"]);
  assertEquals(m.get("ana@acme.com"), { health: 90, sent: 40, landed_inbox: 36, landed_spam: 4, received: 38 });
  assertEquals(m.has("otro@acme.com"), false);
  assertEquals(parseInstantlyStats({ aggregate_data: { "a@b.co": { health_score: 97 } } }, ["a@b.co"]).get("a@b.co")?.health, 97);
  assertEquals(parseInstantlyStats(null, ["a@b.co"]).size, 0);
});

Deno.test("warmupView: nunca inventa métricas", () => {
  assertEquals(warmupView({}, false).state, "unavailable");
  assertEquals(warmupView({ state: "active" }, true).label, "Calentando");
  assert(warmupView({ state: "active", stats: { health: 95 } }, true).label.includes("95 %"));
  assertEquals(warmupView({ state: "error", error: "bad creds" }, true).detail, "bad creds");
  assertEquals(warmupView({}, true).state, "off");
});

Deno.test("appPasswordHosts", () => {
  assertEquals(appPasswordHosts("gmail")?.imap.host, "imap.gmail.com");
  assertEquals(appPasswordHosts("smtp"), null);
});
