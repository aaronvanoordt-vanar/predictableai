// deno test --allow-read _shared/trial-limits.test.ts
import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { CORPORATE_TRIAL, FREE_TRIAL_CREDITS, TRIAL_PLATFORM_REVEALS } from "./billing-plans.ts";
import { platformRevealsLeft, remainingReveals } from "./trial-limits.ts";

Deno.test("remainingReveals cuenta lo cobrado por unidad y nunca baja de cero", () => {
  assertEquals(remainingReveals(25, 0, 2), 25);
  assertEquals(remainingReveals(25, 10, 2), 20);
  assertEquals(remainingReveals(25, 50, 2), 0);
  assertEquals(remainingReveals(25, 80, 2), 0);
  assertEquals(remainingReveals(0, 0, 8), 0);
  assertEquals(remainingReveals(25, -4, 2), 25);
});

// Cliente falso: solo lo que usa platformRevealsLeft.
function fakeSupa(plan: string | Error, deltas: number[] | Error) {
  return {
    rpc: () => Promise.resolve(plan instanceof Error ? { data: null, error: plan } : { data: plan, error: null }),
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve(deltas instanceof Error ? { data: null, error: deltas } : { data: deltas.map((delta) => ({ delta })), error: null }).then(ok),
      };
      return q;
    },
  };
}

Deno.test("platformRevealsLeft: sin tope con plan pago", async () => {
  assertEquals(await platformRevealsLeft(fakeSupa("starter", []), "u", "email"), Infinity);
  assertEquals(await platformRevealsLeft(fakeSupa("growth", []), "u", "phone"), Infinity);
});

Deno.test("platformRevealsLeft: en la prueba descuenta lo ya revelado", async () => {
  assertEquals(await platformRevealsLeft(fakeSupa("free", []), "u", "email"), TRIAL_PLATFORM_REVEALS.email);
  assertEquals(await platformRevealsLeft(fakeSupa("free", [-2, -4, -2]), "u", "email"), TRIAL_PLATFORM_REVEALS.email - 4);
  assertEquals(await platformRevealsLeft(fakeSupa("free", []), "u", "phone"), TRIAL_PLATFORM_REVEALS.phone);
});

Deno.test("platformRevealsLeft: si no puede leer el libro aplica el tope", async () => {
  assertEquals(await platformRevealsLeft(fakeSupa("free", new Error("x")), "u", "email"), 0);
});

Deno.test("la migración de la prueba corporativa es espejo de billing-plans.ts", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261017000001_corporate_trial.sql", import.meta.url));
  assertMatch(sql, new RegExp(`v_free_credits\\s+CONSTANT INT := ${FREE_TRIAL_CREDITS};`));
  assertMatch(sql, new RegExp(`v_corporate_credits CONSTANT INT := ${CORPORATE_TRIAL.credits};`));
  assertMatch(sql, new RegExp(`v_days\\s+CONSTANT INT := ${CORPORATE_TRIAL.days};`));
  // El alta de siempre (handle_new_user_credits) sigue dando FREE_TRIAL_CREDITS.
  const billing = await Deno.readTextFile(new URL("../../migrations/20260923000007_billing_stripe.sql", import.meta.url));
  assertMatch(billing, new RegExp(`VALUES \\(NEW\\.id, ${FREE_TRIAL_CREDITS}, 0\\)`));
});
