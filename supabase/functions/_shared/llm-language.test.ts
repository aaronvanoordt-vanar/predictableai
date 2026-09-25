// deno test _shared/llm-language.test.ts
// El idioma de salida viaja por petición (AsyncLocalStorage) y no se cruza
// entre peticiones concurrentes.
import { assertEquals } from "jsr:@std/assert@1";
import { requestLanguage, setRequestLanguage, withLlmContext } from "./llm.ts";

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
  ]);
  assertEquals(await Promise.all(res.map((r) => r.text())), ["en", "es", "en"]);
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
