// deno test _shared/llm-language.test.ts
// El idioma de salida viaja por petición (AsyncLocalStorage) y no se cruza
// entre peticiones concurrentes.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { callLLM, isOutputLanguage, languageDirective, requestLanguage, setRequestLanguage, withLlmContext } from "./llm.ts";

Deno.test("withLlmContext aísla el idioma entre peticiones concurrentes", async () => {
  const handler = withLlmContext(async (req: Request) => {
    const lang = new URL(req.url).searchParams.get("lang");
    await new Promise((r) => setTimeout(r, 3));
    setRequestLanguage(lang); // lo que hace engineForUser() tras leer profiles
    await new Promise((r) => setTimeout(r, 3));
    return new Response(requestLanguage());
  });
  const res = await Promise.all([
    handler(new Request("http://x/?lang=en")),
    handler(new Request("http://x/?lang=es")),
    handler(new Request("http://x/?lang=en")),
    handler(new Request("http://x/?lang=pt-BR")),
  ]);
  assertEquals(await Promise.all(res.map((r) => r.text())), ["en", "es", "en", "pt-BR"]);
});

Deno.test("fuera de withLlmContext el idioma es español y setRequestLanguage no hace nada", () => {
  setRequestLanguage("en");
  assertEquals(requestLanguage(), "es");
});

Deno.test("un valor inválido no cambia el idioma", async () => {
  const handler = withLlmContext(async () => {
    setRequestLanguage("fr");
    return new Response(requestLanguage());
  });
  assertEquals(await (await handler(new Request("http://x/"))).text(), "es");
});

Deno.test("pt-BR es un idioma de salida válido; pt o pt-PT no", () => {
  assertEquals(isOutputLanguage("pt-BR"), true);
  assertEquals(isOutputLanguage("pt"), false);
  assertEquals(isOutputLanguage("pt-PT"), false);
});

Deno.test("la directiva de pt-BR pide portugués de Brasil con «você»; español no lleva directiva", () => {
  assertEquals(languageDirective("es"), "");
  const d = languageDirective("pt-BR");
  assertStringIncludes(d, "Brazilian Portuguese");
  assertStringIncludes(d, "você");
  assertStringIncludes(d, "never European Portuguese");
  assertEquals(languageDirective("en").includes("você"), false);
});

// De punta a punta: el idioma que engineForUser deja en la petición llega al
// system prompt que callLLM manda al proveedor.
Deno.test("callLLM agrega la directiva de pt-BR al system prompt de la petición", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = Deno.env.get("ANTHROPIC_API_KEY");
  const systems: string[] = [];
  Deno.env.set("ANTHROPIC_API_KEY", "test-key");
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    systems.push(JSON.parse(String(init?.body ?? "{}")).system ?? "");
    return Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }), { status: 200 }));
  }) as typeof fetch;
  try {
    const run = (lang: string) => withLlmContext(async () => {
      setRequestLanguage(lang);
      const r = await callLLM({ engine: "claude", system: "Responde en español.", user: "hola", maxTokens: 10, retries: 0 });
      return new Response(r.text);
    })(new Request("http://x/"));
    await run("pt-BR");
    await run("es");
    assertEquals(systems.length, 2);
    assertStringIncludes(systems[0], "Responde en español.");
    assertStringIncludes(systems[0], "Brazilian Portuguese");
    assertEquals(systems[1], "Responde en español.");
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) Deno.env.delete("ANTHROPIC_API_KEY"); else Deno.env.set("ANTHROPIC_API_KEY", prevKey);
  }
});

// El coach en vivo por el worker de OpenAI arma su prompt en el navegador y no
// pasa por callLLM: js/realtime-coach.js repite la directiva. Deben coincidir.
Deno.test("js/realtime-coach.js espeja la directiva de pt-BR de languageDirective()", async () => {
  const js = await Deno.readTextFile(new URL("../../../js/realtime-coach.js", import.meta.url));
  const style = languageDirective("pt-BR").split("in Spanish\".")[1].split(" Keep JSON keys")[0];
  assertStringIncludes(js, style.trim());
  assertStringIncludes(js, "Brazilian Portuguese (pt-BR)");
});
