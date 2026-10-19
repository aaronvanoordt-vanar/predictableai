/**
 * apollo-webhook — Supabase Edge Function
 *
 * Receives Apollo.io's asynchronous phone-number enrichment callback,
 * triggered by /people/match or /people/bulk_match calls where apollo-proxy
 * injected reveal_phone_number + this function's URL as webhook_url.
 *
 * PUBLIC endpoint — Apollo cannot send a Supabase JWT, so deploy with:
 *   supabase functions deploy apollo-webhook --no-verify-jwt
 * It self-authenticates instead: the `token` URL query param must equal the
 * APOLLO_WEBHOOK_SECRET env secret. Only apollo-proxy ever embeds that token
 * (in the webhook_url it hands to Apollo), so possession of the token proves
 * the caller is Apollo relaying one of our own reveal requests.
 *
 * Behavior: for each person in the payload, picks the best phone number
 * (mobile > unknown > landline > switchboard, normalized to E.164 with its
 * line type by _shared/phone-latam.ts — 2026-10-17), then updates prospect_list_members rows
 * awaiting it (apollo_person_id match + phone_status = 'pending') via the
 * service-role client: phone, phone_status = 'revealed' (or 'unavailable'
 * when Apollo returned no numbers), enriched_at, and merges the raw
 * phone_numbers array into snapshot.
 *
 * Always answers 200 {received: true} — including on unknown payload shapes
 * (logged) — so Apollo does not retry-storm us.
 *
 * Expected payload (variations tolerated):
 *   { id: <request_id>, people: [ { id, phone_numbers: [ { raw_number,
 *     sanitized_number, type, status, ... } ], ... } ] }
 *   — or a single `person` object instead of a `people` array.
 *
 * Required secrets: APOLLO_WEBHOOK_SECRET
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pickBestPhone } from "../_shared/phone-latam.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface PhoneNumber {
  raw_number?: string;
  sanitized_number?: string;
  type?: string;
  status?: string;
}

interface WebhookPerson {
  id?: unknown;
  phone_numbers?: unknown;
}

/** Best number in E.164 + its line type (_shared/phone-latam.ts); the lead's country reads national formats. */
function bestNumber(numbers: PhoneNumber[], country: unknown) {
  return pickBestPhone(numbers.map((n) => ({ number: n?.sanitized_number || n?.raw_number, type: n?.type })), country);
}

// Columns from migration 20261017000001; until it is applied the row is saved without them.
const NEW_COLS = ["phone_type", "source_provider"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const secret = Deno.env.get("APOLLO_WEBHOOK_SECRET");
  if (!secret) return json({ error: "APOLLO_WEBHOOK_SECRET secret not configured" }, 503);

  const token = new URL(req.url).searchParams.get("token");
  if (!token || token !== secret) return json({ error: "Unauthorized" }, 401);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch (_) {
    console.warn("[apollo-webhook] non-JSON payload, acking anyway");
    return json({ received: true });
  }

  // Tolerate both shapes: people[] and a single person object.
  const people: WebhookPerson[] = [];
  if (Array.isArray(payload.people)) {
    people.push(...(payload.people as WebhookPerson[]));
  } else if (payload.person && typeof payload.person === "object") {
    people.push(payload.person as WebhookPerson);
  }

  if (!people.length) {
    console.warn(
      "[apollo-webhook] unknown payload shape:",
      JSON.stringify(payload).slice(0, 500),
    );
    return json({ received: true });
  }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Payloads are small — one batched SELECT for all persons, then the
  // per-row UPDATEs (independent writes) in parallel before acking.
  const byPerson = new Map<string, PhoneNumber[]>();
  for (const person of people) {
    const personId = person?.id;
    if (typeof personId !== "string" || !personId) {
      console.warn("[apollo-webhook] person entry without id, skipping");
      continue;
    }
    byPerson.set(
      personId,
      Array.isArray(person.phone_numbers) ? (person.phone_numbers as PhoneNumber[]) : [],
    );
  }
  if (!byPerson.size) return json({ received: true });

  const { data: rows, error: selErr } = await supa
    .from("prospect_list_members")
    .select("*")
    .in("apollo_person_id", [...byPerson.keys()])
    .eq("phone_status", "pending");

  if (selErr) {
    console.error("[apollo-webhook] select failed:", selErr.message);
    return json({ received: true });
  }
  if (!rows || !rows.length) {
    console.warn("[apollo-webhook] no pending rows for", [...byPerson.keys()].join(","));
    return json({ received: true });
  }

  await Promise.all(rows.map((row) => {
    const numbers = byPerson.get(row.apollo_person_id as string) ?? [];
    const best = bestNumber(numbers, row.country);
    const snapshot = {
      ...((row.snapshot && typeof row.snapshot === "object") ? row.snapshot : {}),
      phone_numbers: numbers,
    };
    const update: Record<string, unknown> = best
      ? {
        phone: best.e164,
        phone_status: "revealed",
        enriched_at: new Date().toISOString(),
        snapshot,
        phone_type: best.type,
        source_provider: { ...((row.source_provider && typeof row.source_provider === "object") ? row.source_provider : {}), phone: "apollo" },
      }
      : { phone_status: "unavailable", snapshot };
    const save = async () => {
      let { error: updErr } = await supa.from("prospect_list_members").update(update).eq("id", row.id);
      if (updErr && NEW_COLS.some((c) => (updErr!.message || "").includes(c))) {
        for (const c of NEW_COLS) delete update[c];
        ({ error: updErr } = await supa.from("prospect_list_members").update(update).eq("id", row.id));
      }
      if (updErr) console.error(`[apollo-webhook] update failed for row ${row.id}:`, updErr.message);
    };
    return save();
  }));
  console.log(`[apollo-webhook] ✓ ${rows.length} row(s) across ${byPerson.size} person(s)`);

  return json({ received: true });
});
