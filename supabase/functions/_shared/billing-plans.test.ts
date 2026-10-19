// deno test supabase/functions/_shared/billing-plans.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { plansForUsers } from "./billing-plans.ts";

// deno-lint-ignore no-explicit-any
function fakeSupa(tables: Record<string, { data?: any[]; error?: { message: string } }>) {
  return {
    from(table: string) {
      return {
        select() { return this; },
        in() { return Promise.resolve(tables[table] ?? { data: [] }); },
      };
    },
  };
}

Deno.test("plansForUsers: como current_plan(), una cuenta ilimitada es growth", async () => {
  const supa = fakeSupa({
    subscriptions: { data: [
      { user_id: "a", plan: "starter", status: "active" },
      { user_id: "b", plan: "starter", status: "canceled" },
      { user_id: "d", plan: "starter", status: "active" },
    ] },
    user_credits: { data: [
      { user_id: "c", unlimited: true },
      { user_id: "d", unlimited: true },
      { user_id: "e", unlimited: false },
    ] },
  });
  const plans = await plansForUsers(supa, ["a", "b", "c", "d", "e"]);
  assertEquals(Object.fromEntries(plans), { a: "starter", b: "free", c: "growth", d: "growth", e: "free" });
});

Deno.test("plansForUsers: sin user_credits legible se queda con la suscripción", async () => {
  const supa = fakeSupa({
    subscriptions: { data: [{ user_id: "a", plan: "growth", status: "active" }] },
    user_credits: { error: { message: "boom" } },
  });
  const plans = await plansForUsers(supa, ["a", "b"]);
  assertEquals(Object.fromEntries(plans), { a: "growth", b: "free" });
});
