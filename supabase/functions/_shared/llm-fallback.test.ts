// deno test --allow-env _shared/llm-fallback.test.ts
// Cuando la cuenta de la PLATAFORMA en un proveedor se queda sin saldo (o su
// clave es rechazada), callLLM pasa a otro motor configurado y, si no queda
// ninguno, devuelve un mensaje que no se confunde con los créditos del usuario.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { _resetProviderCooldowns, callLLM, LlmProviderUnavailableError, providerAccountProblem } from "./llm.ts";

const ANTHROPIC_NO_BALANCE = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." },
});
const OPENAI_NO_QUOTA = JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" } });

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PERPLEXITY_API_KEY"];

async function withEnv(keys: Record<string, string>, fetchImpl: (url: string) => Response, fn: (hosts: string[]) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const prev = Object.fromEntries(KEYS.map((k) => [k, Deno.env.get(k)]));
  const hosts: string[] = [];
  for (const k of KEYS) Deno.env.delete(k);
  for (const [k, v] of Object.entries(keys)) Deno.env.set(k, v);
  _resetProviderCooldowns();
  globalThis.fetch = ((url: string) => {
    hosts.push(new URL(url).host);
    return Promise.resolve(fetchImpl(url));
  }) as typeof fetch;
  try {
    await fn(hosts);
  } finally {
    globalThis.fetch = realFetch;
    _resetProviderCooldowns();
    for (const k of KEYS) { const v = prev[k]; if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

const perplexityOk = () => new Response(JSON.stringify({ choices: [{ message: { content: "desde perplexity" } }] }), { status: 200 });

Deno.test("providerAccountProblem reconoce saldo agotado y clave rechazada, no otros errores", () => {
  assertEquals(providerAccountProblem(400, ANTHROPIC_NO_BALANCE), "billing");
  assertEquals(providerAccountProblem(429, OPENAI_NO_QUOTA), "billing");
  assertEquals(providerAccountProblem(402, "{}"), "billing");
  assertEquals(providerAccountProblem(401, '{"error":"invalid x-api-key"}'), "auth");
  assertEquals(providerAccountProblem(429, '{"error":{"type":"rate_limit_error"}}'), null);
  assertEquals(providerAccountProblem(400, '{"error":{"message":"max_tokens: too large"}}'), null);
  assertEquals(providerAccountProblem(529, "overloaded"), null);
});

Deno.test("Claude sin saldo → la llamada sale por otro motor configurado", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "a", PERPLEXITY_API_KEY: "p" }, (url) =>
    url.includes("anthropic") ? new Response(ANTHROPIC_NO_BALANCE, { status: 400 }) : perplexityOk(),
  async (hosts) => {
    const r = await callLLM({ engine: "claude", system: "s", user: "u", maxTokens: 10, retryDelayMs: 1 });
    assertEquals(r.engine, "perplexity");
    assertEquals(r.text, "desde perplexity");
    // Sin reintentos contra la cuenta vacía.
    assertEquals(hosts.filter((h) => h.includes("anthropic")).length, 1);
    // La siguiente llamada ya no toca a Claude mientras dura la espera.
    await callLLM({ engine: "claude", system: "s", user: "u", maxTokens: 10 });
    assertEquals(hosts.filter((h) => h.includes("anthropic")).length, 1);
  });
});

Deno.test("sin otro motor: error claro que no habla de los créditos del usuario como agotados", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "a" }, () => new Response(ANTHROPIC_NO_BALANCE, { status: 400 }), async () => {
    const err = await assertRejects(
      () => callLLM({ engine: "claude", system: "s", user: "u", maxTokens: 10, retryDelayMs: 1 }),
      LlmProviderUnavailableError,
    );
    assertStringIncludes(err.message, "No son tus créditos de Predictable");
    assert(!err.message.includes("credit balance"));
  });
});

Deno.test("un PDF no cae a Perplexity aunque Claude esté sin saldo", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "a", PERPLEXITY_API_KEY: "p" }, (url) =>
    url.includes("anthropic") ? new Response(ANTHROPIC_NO_BALANCE, { status: 400 }) : perplexityOk(),
  async (hosts) => {
    await assertRejects(
      () => callLLM({ engine: "claude", system: "s", user: "u", maxTokens: 10, documents: [{ name: "x.pdf", base64: "AA==" }] }),
      LlmProviderUnavailableError,
    );
    assert(!hosts.some((h) => h.includes("perplexity")));
  });
});

Deno.test("un error normal del proveedor no cambia de motor", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "a", PERPLEXITY_API_KEY: "p" }, (url) =>
    url.includes("anthropic") ? new Response('{"error":{"message":"max_tokens: too large"}}', { status: 400 }) : perplexityOk(),
  async (hosts) => {
    await assertRejects(() => callLLM({ engine: "claude", system: "s", user: "u", maxTokens: 10 }), Error, "Claude 400");
    assert(!hosts.some((h) => h.includes("perplexity")));
  });
});
