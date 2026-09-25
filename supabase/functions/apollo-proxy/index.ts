/**
 * apollo-proxy — Supabase Edge Function
 *
 * Forwards allowlisted Apollo.io API calls with a server-side credential, so
 * no key ever ships to the browser (it used to be hardcoded in index.html and
 * exposed via GitHub Pages).
 *
 * WHICH CREDENTIAL (opción B, 2026-09-03 — see _shared/apollo-auth.ts): if the
 * user connected their own Apollo via OAuth (channel_accounts provider=apollo)
 * the call goes out with THEIR bearer token and Apollo bills THEIR account; if
 * not, the platform's shared APOLLO_API_KEY is used (beta fallback). In oauth
 * mode /people/match reveals do NOT charge predictable credits — the customer
 * already pays Apollo for them.
 *
 * The shared key backs SEARCH AND ENRICHMENT ONLY. Every mail endpoint
 * (/email_accounts and /emailer_*) is refused in platform mode with 403
 * apollo_account_required: those read or move the mailboxes of one concrete
 * Apollo account, and in platform mode that account belongs to someone else —
 * a new customer was shown the platform owner's inbox as if it were their own
 * connected Email channel. Email is connected per user, like WhatsApp/LinkedIn.
 *
 * Auth: Bearer <user JWT>, validated with auth.getUser() — the platform's
 *       verify_jwt alone also accepts the public anon key, which would make
 *       this an open proxy anyone could use to burn Apollo credits (the same
 *       class of hole PR #25 fixed in decrement_credits).
 *
 * The allowlist pins the upstream HTTP (endpoint, method) PAIRS server-side —
 * the client may only name a pair that appears here, and for the endpoints
 * that accept a single verb it does not name a method at all. For phone reveals
 * (reveal_phone_number: true on /people/match or /people/bulk_match) this
 * function injects the apollo-webhook callback URL itself; any
 * client-supplied webhook_url is always discarded, so Apollo can never be
 * pointed at an attacker-controlled server.
 *
 * POST body: { "endpoint": "/people/match", "method": "POST", "body": { ... } }
 *            ("method" is only required for the few endpoints that accept
 *             more than one verb; otherwise it is inferred.)
 * Required secrets: APOLLO_API_KEY (platform fallback)
 *                   APOLLO_OAUTH_CLIENT_ID / APOLLO_OAUTH_CLIENT_SECRET (to
 *                     refresh a connected user's token)
 *                   APOLLO_WEBHOOK_SECRET (only for phone-reveal requests)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { ApolloError, resolveApolloAuth } from "../_shared/apollo-auth.ts";
import type { ApolloAuth } from "../_shared/apollo-auth.ts";
import { apolloBillableCount, CREDIT_COSTS } from "../_shared/credit-costs.ts";
import { refundCredits, reserveCredits, settleReservation } from "../_shared/credits.ts";
import { blockedInPlatformMode, PLATFORM_SKIPPED_CONTACT, sanitizePlatformSearch } from "../_shared/apollo-platform.ts";

type Method = "GET" | "POST" | "PUT" | "DELETE";

// endpoint → the upstream verbs it may be called with, fixed server-side.
// The first entry is the default when the client names no method.
const STATIC_ENDPOINTS = new Map<string, Method[]>([
  ["/mixed_people/api_search", ["POST"]],
  ["/people/match", ["POST"]],
  ["/people/bulk_match", ["POST"]],
  ["/contacts", ["POST"]],
  ["/email_accounts", ["GET"]],
  // Who is the credential acting as (the user's own Apollo in oauth mode, the
  // workspace admin in platform mode). Cheap, 0 credits.
  ["/users/api_profile", ["GET"]],
  ["/emailer_messages/email_send_status", ["POST"]],
  // Bandeja: the emails Apollo has sent/scheduled, with their delivery state.
  // NOTE: this only ever returns OUTBOUND mail. Apollo has no inbound message
  // type — it reports `replied`/`reply_class` on the message that got answered
  // but never the prospect's text, which is why the Bandeja reads the actual
  // conversation from Gmail (see supabase/functions/gmail-proxy).
  // Also verified the hard way: its `contact_ids` and `provider_thread_id`
  // filters are accepted and then SILENTLY IGNORED — never filter on those.
  ["/emailer_messages/search", ["POST"]],
  // Replying from the Bandeja: create a draft, then dispatch it.
  ["/emailer_messages", ["POST"]],
]);

// Dynamic entries: the id segment is validated by SHAPE only (URL-safe token,
// no slashes) — the anti-abuse guarantee is the path pattern, not Apollo's
// internal id encoding. The Apollo-sequence endpoints (emailer_campaigns /
// emailer_steps / emailer_touches / emailer_schedules) were dropped on
// 2026-09-25: js/apollo-sequences.js died in PR #31 and no caller remained
// (grep js/), so they were attack surface without users.
const ID = "[A-Za-z0-9_-]{8,64}";
const DYNAMIC_ENDPOINTS: Array<{ re: RegExp; methods: Method[] }> = [
  // ⚠️ SENDS A REAL EMAIL, IMMEDIATELY. Not "schedules", not "validates":
  // probing this with an empty body dispatched a live message to a prospect
  // one second later. There is no unsend — /cancel, /unschedule and DELETE on
  // an emailer_message all 404. Every caller must confirm with the user first.
  { re: new RegExp(`^/emailer_messages/${ID}/send_now$`), methods: ["POST"] },
];

// Endpoints de correo: leen o mueven buzones y mensajes de una cuenta de
// Apollo concreta. En modo `platform` esa cuenta es la compartida de la beta
// (otra persona), así que se bloquean: listarlos le enseñaba al cliente nuevo
// el buzón del dueño de la plataforma como si fuera suyo, y enviar habría
// mandado el correo desde ese buzón. Buscar y enriquecer sí siguen cayendo a
// la key compartida — ahí no hay identidad de nadie de por medio.
const OWN_ACCOUNT_ONLY = /^\/(email_accounts|emailer_)/;

function requiresOwnApollo(endpoint: string): boolean {
  return OWN_ACCOUNT_ONLY.test(endpoint);
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "X-Apollo-Auth-Mode, X-Apollo-Account-Email",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  ).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, cors);

  let payload: { endpoint?: unknown; method?: unknown; body?: unknown };
  try {
    payload = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON body" }, 400, cors);
  }

  const endpoint = payload.endpoint;
  if (typeof endpoint !== "string") {
    return json({ error: "Endpoint not allowed" }, 400, cors);
  }
  const allowed = STATIC_ENDPOINTS.get(endpoint) ??
    DYNAMIC_ENDPOINTS.find((d) => d.re.test(endpoint))?.methods;
  if (!allowed) return json({ error: "Endpoint not allowed" }, 400, cors);

  // The client may only pick from the verbs this endpoint declares; naming no
  // method keeps the old behavior (the endpoint's single/default verb).
  let method: Method;
  if (payload.method === undefined) {
    method = allowed[0];
  } else if (typeof payload.method === "string" && (allowed as string[]).includes(payload.method)) {
    method = payload.method as Method;
  } else {
    return json({ error: "Method not allowed for this endpoint" }, 400, cors);
  }

  const body: Record<string, unknown> =
    payload.body && typeof payload.body === "object" && !Array.isArray(payload.body)
      ? { ...(payload.body as Record<string, unknown>) }
      : {};

  // SECURITY: never forward a client-supplied webhook_url — Apollo would POST
  // the revealed data (and our secret token pattern) wherever it points.
  delete body.webhook_url;

  if (endpoint === "/people/match" || endpoint === "/people/bulk_match") {
    if (body.reveal_phone_number === true) {
      const webhookSecret = Deno.env.get("APOLLO_WEBHOOK_SECRET");
      if (!webhookSecret) {
        return json({ error: "APOLLO_WEBHOOK_SECRET secret not configured" }, 503, cors);
      }
      body.webhook_url =
        `${Deno.env.get("SUPABASE_URL")!}/functions/v1/apollo-webhook` +
        `?token=${encodeURIComponent(webhookSecret)}`;
    } else {
      delete body.reveal_phone_number;
    }
  }

  // ── Credencial de Apollo: la del usuario (OAuth) o la de la plataforma ──
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let auth: ApolloAuth;
  try {
    auth = await resolveApolloAuth(svc, user.id);
  } catch (e) {
    const status = e instanceof ApolloError ? e.status : 500;
    return json({ error: (e as Error).message }, status, cors);
  }

  if (auth.mode === "platform" && requiresOwnApollo(endpoint)) {
    return json({
      error: "apollo_account_required",
      message: "Conecta tu cuenta de Apollo para usar el canal de Email: la cuenta compartida de la beta no envía correo a tu nombre.",
    }, 403, cors);
  }

  // La cuenta compartida es la misma para todos los clientes: lo que uno
  // guarda ahí lo ve el siguiente (ver _shared/apollo-platform.ts). El lead
  // se queda solo en Predictable, con su RLS por dueño.
  if (auth.mode === "platform" && blockedInPlatformMode(endpoint)) {
    return json(PLATFORM_SKIPPED_CONTACT, 200, { ...cors, "X-Apollo-Auth-Mode": auth.mode, "X-Apollo-Account-Email": "" });
  }

  // ── Cobro de créditos por enriquecimiento (_shared/credit-costs.ts) ─────
  // 2 créditos por email, 8 por teléfono, por persona ENCONTRADA. Solo
  // match/bulk_match (revelar datos de contacto) cobran; búsqueda y CRUD son
  // gratis. Se verifica el saldo para el peor caso (todas encontradas) ANTES
  // de quemar créditos de Apollo, y tras la respuesta se cobra solo lo que
  // trajo dato — igual que Apollo, que no cobra un email que no encontró.
  //
  // En modo `oauth` NO se cobran créditos de predictable: el reveal sale de
  // los créditos del Apollo del propio cliente (él ya se lo paga a Apollo).
  // Los créditos de la plataforma solo cubren la key compartida.
  let creditCost = 0;
  let perPerson = 0;
  let creditReason = "enrich_email";
  const wantsPhone = body.reveal_phone_number === true;
  if (auth.mode === "platform" && (endpoint === "/people/match" || endpoint === "/people/bulk_match")) {
    const people = endpoint === "/people/bulk_match"
      ? (Array.isArray(body.details) ? body.details.length : 1)
      : 1;
    perPerson = wantsPhone ? CREDIT_COSTS.enrich_phone : CREDIT_COSTS.enrich_email;
    creditCost = people * perPerson;
    creditReason = wantsPhone ? "enrich_phone" : "enrich_email";
  }

  const admin = creditCost > 0 ? svc : null;

  if (admin) {
    // Reserva atómica del peor caso ANTES de tocar la key compartida; lo que
    // Apollo no entregó se devuelve abajo. Con una lectura simple, N requests
    // paralelos pasaban el chequeo, todos gastaban créditos reales de Apollo
    // y solo uno pagaba.
    if (!(await reserveCredits(admin, user.id, creditCost))) {
      const { data: c } = await admin.from("user_credits").select("balance").eq("user_id", user.id).maybeSingle();
      return json({ error: "insufficient_credits", balance: c?.balance ?? 0, cost: creditCost }, 402, cors);
    }
  }

  const sendsBody = method === "POST" || method === "PUT";
  const init: RequestInit = {
    method,
    headers: {
      "Cache-Control": "no-cache",
      ...auth.headers,
      ...(sendsBody ? { "Content-Type": "application/json" } : {}),
    },
  };
  // GET/DELETE carry everything they need in the path — forward with no body.
  if (sendsBody) init.body = JSON.stringify(body);

  init.signal = AbortSignal.timeout(60_000);
  let res: Response;
  try {
    res = await fetch("https://api.apollo.io/api/v1" + endpoint, init);
  } catch (e) {
    if (admin) await refundCredits(admin, user.id, creditCost, creditReason + "_refund");
    console.error(`[apollo-proxy] upstream unreachable for ${endpoint}:`, (e as Error).message);
    return json({ error: "Apollo no respondió a tiempo. Inténtalo de nuevo en unos segundos." }, 504, cors);
  }

  let text = await res.text();
  if (res.ok && auth.mode === "platform" && endpoint === "/mixed_people/api_search") {
    try {
      text = JSON.stringify(sanitizePlatformSearch(JSON.parse(text)));
    } catch (_) {
      // Si no se puede limpiar, no se entrega: podría traer contactos ajenos.
      return json({ error: "Respuesta de Apollo no válida" }, 502, cors);
    }
  }
  if (!res.ok) {
    console.error(`[apollo-proxy] upstream ${res.status} for ${endpoint}: ${text.slice(0, 300)}`);
  }

  // Cobrar solo si Apollo respondió OK y solo por las personas con dato; el
  // resto de la reserva vuelve al saldo (todo, si Apollo falló).
  let charge = 0;
  if (admin && res.ok) {
    try {
      charge = apolloBillableCount(endpoint, JSON.parse(text), wantsPhone) * perPerson;
    } catch {
      charge = creditCost; // respuesta ilegible: se cobra lo pedido, como antes
    }
  }
  if (admin) await settleReservation(admin, user.id, creditCost, charge, creditReason);

  return new Response(text, {
    status: res.status,
    // Para que la UI sepa de quién es la cuenta que respondió (y pueda
    // nombrarla en errores de créditos en vez de decir "tu cuenta de Apollo"
    // a ciegas — headers, no body, porque este Response reenvía el texto
    // crudo de Apollo tal cual).
    headers: {
      "Content-Type": "application/json",
      "X-Apollo-Auth-Mode": auth.mode,
      "X-Apollo-Account-Email": auth.accountEmail ?? "",
      ...cors,
    },
  });
});
