/**
 * whatsapp-followups — Supabase Edge Function (scheduler)
 *
 * Called by pg_cron every minute (same pattern as the intel-hub jobs) to send
 * WhatsApp follow-up messages whose send_at has passed. Rows live in
 * whatsapp_followups and are scheduled/cancelled directly from the browser
 * (client-writable table, owner-scoped RLS).
 *
 * Must be called with the service_role key:
 *   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 *
 * Claim protocol: each due row is claimed with an atomic
 * UPDATE … SET status='processing' WHERE status='pending', so overlapping
 * cron runs never double-send. Rows stuck in 'processing' for over 10 minutes
 * (a previous run crashed mid-send) are reset to 'pending' at the start of
 * each run.
 *
 * A follow-up can fail for product reasons — most commonly Meta's 24-hour
 * customer-service window (error 131047) when the contact never replied.
 * Those rows end as status='failed' with a human-readable error_detail that
 * the inbox surfaces to the user.
 *
 * Required secrets: none beyond the platform-provided SUPABASE_* vars.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v23.0";
const BATCH = 50;
const STALE_PROCESSING_MS = 10 * 60 * 1000;

// deno-lint-ignore no-explicit-any
type Json = any;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function metaErrorMessage(err: Json): string {
  const code = err?.code;
  const detail = err?.error_data?.details || err?.message || "Error de WhatsApp";
  if (code === 131047 || code === 131026) {
    return "Fuera de la ventana de 24 horas: el contacto no ha escrito en las últimas 24 h. Reabre la conversación con una plantilla.";
  }
  if (code === 190) return "El access token de Meta expiró. Reconecta tu número de WhatsApp.";
  return String(detail).slice(0, 300);
}

/**
 * Role claim of a JWT whose SIGNATURE was already validated by the platform
 * gateway (verify_jwt). An exact string-compare against the
 * SUPABASE_SERVICE_ROLE_KEY env var is too brittle here: the pg_cron jobs
 * carry the project's legacy service-role JWT, which is signed with the same
 * secret but is not byte-identical to the env var value (verified in prod —
 * the exact-match variant 401'd the cron caller).
 */
function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Gateway already verified the signature; reject anything that isn't the
  // service role (user JWTs and the public anon key also pass the gateway).
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (token !== serviceKey && jwtRole(token) !== "service_role") {
    return json({ error: "Unauthorized" }, 401);
  }

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
    auth: { persistSession: false },
  });

  // Recover rows a crashed run left behind.
  await supa
    .from("whatsapp_followups")
    .update({ status: "pending" })
    .eq("status", "processing")
    .lt("updated_at", new Date(Date.now() - STALE_PROCESSING_MS).toISOString());

  const now = new Date().toISOString();
  const { data: due, error: dueErr } = await supa
    .from("whatsapp_followups")
    .select("id, user_id, conversation_id, body, send_at")
    .eq("status", "pending")
    .lte("send_at", now)
    .order("send_at", { ascending: true })
    .limit(BATCH);
  if (dueErr) return json({ error: dueErr.message }, 500);
  if (!due?.length) return json({ ok: true, sent: 0, failed: 0 });

  let sent = 0, failed = 0, skipped = 0;

  for (const fu of due) {
    // Atomic claim — zero rows back means another run got it first.
    const { data: claimed } = await supa
      .from("whatsapp_followups")
      .update({ status: "processing" })
      .eq("id", fu.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed?.length) { skipped++; continue; }

    const finish = (patch: Json) =>
      supa.from("whatsapp_followups").update(patch).eq("id", fu.id);

    try {
      const { data: conv } = await supa
        .from("whatsapp_conversations")
        .select("*")
        .eq("id", fu.conversation_id)
        .maybeSingle();
      if (!conv) {
        await finish({ status: "failed", error_detail: "La conversación ya no existe." });
        failed++;
        continue;
      }
      const { data: account } = await supa
        .from("whatsapp_accounts")
        .select("*")
        .eq("id", conv.account_id)
        .maybeSingle();
      if (!account) {
        await finish({ status: "failed", error_detail: "El número de WhatsApp fue desconectado." });
        failed++;
        continue;
      }

      const res = await fetch(`${GRAPH}/${account.phone_number_id}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${account.access_token}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: conv.wa_id,
          type: "text",
          text: { body: fu.body, preview_url: true },
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        await finish({ status: "failed", error_detail: metaErrorMessage(data?.error) });
        failed++;
        continue;
      }

      const sentAt = new Date().toISOString();
      const { data: msgRow } = await supa
        .from("whatsapp_messages")
        .insert({
          conversation_id: conv.id,
          user_id: conv.user_id,
          wamid: data?.messages?.[0]?.id ?? null,
          direction: "out",
          type: "text",
          body: fu.body,
          status: "pending",
          sent_at: sentAt,
        })
        .select("id")
        .single();

      await supa
        .from("whatsapp_conversations")
        .update({
          last_message_at: sentAt,
          last_message_preview: fu.body.slice(0, 120),
          last_message_direction: "out",
        })
        .eq("id", conv.id);

      await finish({ status: "sent", sent_message_id: msgRow?.id ?? null, error_detail: null });
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[wa-followups] ${fu.id}: ${msg}`);
      await finish({ status: "failed", error_detail: msg.slice(0, 300) });
      failed++;
    }
  }

  console.log(`[wa-followups] due=${due.length} sent=${sent} failed=${failed} skipped=${skipped}`);
  return json({ ok: true, sent, failed, skipped });
});
