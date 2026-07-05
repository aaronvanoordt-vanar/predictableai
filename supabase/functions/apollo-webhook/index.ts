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
 * (mobile > any sanitized > raw), then updates prospect_list_members rows
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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

/** Best number: mobile with sanitized_number > any sanitized_number > raw. */
function bestNumber(numbers: PhoneNumber[]): string | null {
  const mobile = numbers.find((n) => n?.type === "mobile" && n?.sanitized_number);
  if (mobile?.sanitized_number) return mobile.sanitized_number;
  const sanitized = numbers.find((n) => n?.sanitized_number);
  if (sanitized?.sanitized_number) return sanitized.sanitized_number;
  const raw = numbers.find((n) => n?.raw_number);
  return raw?.raw_number ?? null;
}

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
    .select("id, apollo_person_id, snapshot")
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
    const phone = bestNumber(numbers);
    const snapshot = {
      ...((row.snapshot && typeof row.snapshot === "object") ? row.snapshot : {}),
      phone_numbers: numbers,
    };
    const update = phone
      ? { phone, phone_status: "revealed", enriched_at: new Date().toISOString(), snapshot }
      : { phone_status: "unavailable", snapshot };
    return supa
      .from("prospect_list_members")
      .update(update)
      .eq("id", row.id)
      .then(({ error: updErr }) => {
        if (updErr) console.error(`[apollo-webhook] update failed for row ${row.id}:`, updErr.message);
      });
  }));
  console.log(`[apollo-webhook] ✓ ${rows.length} row(s) across ${byPerson.size} person(s)`);

  return json({ received: true });
});
