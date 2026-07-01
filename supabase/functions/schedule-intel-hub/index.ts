/**
 * schedule-intel-hub — Supabase Edge Function (scheduler)
 *
 * Called by pg_cron (or an external cron service) to trigger automatic
 * refresh of Intelligence Hub sections whose next_refresh_at has passed
 * (or that have never been generated).
 *
 * POST body:
 *   { "cadence": "daily" | "weekly" | "monthly" | "quarterly" | "yearly" }
 *   Omit cadence to process ALL due sections across all cadences.
 *
 * Must be called with the service_role key:
 *   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 *
 * This function fans out to generate-intel-hub for each user that needs refresh.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CADENCE_SECTIONS: Record<string, string[]> = {
  daily:     ["industry_insight_digest", "competitor_threat_radar", "prospecting_recommendations"],
  weekly:    ["benchmark", "revenue_opportunities", "strategic_actions"],
  monthly:   ["consumer_behavioral_analysis", "market_snapshot", "future_innovations"],
  quarterly: ["pestel"],
  yearly:    ["market_architecture"],
};

const ALL_CADENCES = Object.keys(CADENCE_SECTIONS) as Array<keyof typeof CADENCE_SECTIONS>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Only allow service_role callers
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${serviceKey}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Fail loudly if the shared secret is missing: without it every fan-out call
  // to generate-intel-hub is rejected 401 and the whole scheduler silently
  // no-ops. Surface it here instead of per-user failures.
  const schedulerSecret = Deno.env.get("SCHEDULER_SECRET") ?? "";
  if (!schedulerSecret) {
    console.error("[scheduler] SCHEDULER_SECRET is not set — aborting.");
    return json({ error: "SCHEDULER_SECRET not configured" }, 500);
  }

  let body: { cadence?: string } = {};
  try { body = await req.json(); } catch { /* no body = run all */ }

  const cadencesToRun = body.cadence ? [body.cadence] : ALL_CADENCES;

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const generateFnUrl = `${supabaseUrl}/functions/v1/generate-intel-hub`;
  const now = new Date().toISOString();
  const results: Record<string, unknown> = {};

  for (const cadence of cadencesToRun) {
    const sections = CADENCE_SECTIONS[cadence];
    if (!sections) continue;

    // Find users who:
    //  a) completed intake (have a what_to_know row), AND
    //  b) have at least one section in this cadence that is either:
    //     - missing (never generated), OR
    //     - past its next_refresh_at
    const { data: intakeUsers, error: intakeErr } = await supabase
      .from("intel_hub_intake")
      .select("user_id")
      .not("what_to_know", "is", null)
      .neq("what_to_know", "");

    if (intakeErr || !intakeUsers?.length) {
      results[cadence] = { skipped: true, reason: intakeErr?.message ?? "no users" };
      continue;
    }

    const userIds = intakeUsers.map((r: { user_id: string }) => r.user_id);

    // For each section in this cadence, find users who are due
    const { data: existingReports } = await supabase
      .from("intelligence_hub_reports")
      .select("user_id, section_key, next_refresh_at, status")
      .in("user_id", userIds)
      .in("section_key", sections);

    // Build a set of (user_id, section_key) that are already up-to-date
    const upToDate = new Set<string>();
    for (const row of existingReports ?? []) {
      if (
        row.status === "generating" ||
        (row.next_refresh_at && row.next_refresh_at > now && row.status === "ready")
      ) {
        upToDate.add(`${row.user_id}::${row.section_key}`);
      }
    }

    // Determine which users need at least one section refreshed
    const usersNeedingRefresh = new Set<string>();
    const userSectionsNeeded: Record<string, string[]> = {};

    for (const userId of userIds) {
      for (const sectionKey of sections) {
        if (!upToDate.has(`${userId}::${sectionKey}`)) {
          usersNeedingRefresh.add(userId);
          if (!userSectionsNeeded[userId]) userSectionsNeeded[userId] = [];
          userSectionsNeeded[userId].push(sectionKey);
        }
      }
    }

    console.log(`[scheduler] cadence=${cadence} users_due=${usersNeedingRefresh.size}`);

    // Fan out — call generate-intel-hub for each user
    const promises = Array.from(usersNeedingRefresh).map(async (userId) => {
      const sectionsForUser = userSectionsNeeded[userId];
      const res = await fetch(generateFnUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Secret": schedulerSecret,
        },
        body: JSON.stringify({
          user_id: userId,
          sections: sectionsForUser,
          triggered_by: "schedule",
        }),
      });
      return { userId, ok: res.ok, status: res.status };
    });

    const fanOutResults = await Promise.allSettled(promises);
    results[cadence] = {
      users_triggered: usersNeedingRefresh.size,
      outcomes: fanOutResults.map((r) =>
        r.status === "fulfilled" ? r.value : { error: String(r.reason) }
      ),
    };
  }

  return json({ ok: true, ran_at: now, results });
});
