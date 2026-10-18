// deno test --allow-read --allow-env _shared/voice-calls.test.ts
// «No me llamen» en una llamada del agente de voz bloquea SOLO las llamadas
// (decisión del dueño, 2026-10-18): nunca una fila con canal `all`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { callOptOutRows } from "./voice-calls.ts";
import { type SuppressionEntry, pickSuppression } from "./suppression.ts";

Deno.test("callOptOutRows: solo canal phone, con el número llamado y el del lead", () => {
  const rows = callOptOutRows({ id: "m1", phone: "+57 310 555 0000", email: "ana@acme.co" }, "+573105551234", { voice_call_id: "c1" });
  assertEquals(rows.map((r) => r.channel), ["phone", "phone"]);
  assert(rows.every((r) => r.kind === "phone" && r.source === "reply" && r.legal_basis === "opt_out" && r.member_id === "m1"));
  assertEquals(rows[0].evidence?.voice_call_id, "c1");
  // Mismo número del lead que el llamado: una sola fila.
  assertEquals(callOptOutRows({ id: "m1", phone: "+57 310 555 1234" }, "+573105551234", {}).length, 1);
  assertEquals(callOptOutRows(null, "+573105551234", {}).length, 1);
});

Deno.test("la fila bloquea llamadas pero no WhatsApp ni email", () => {
  const [row] = callOptOutRows(null, "+573105551234", {});
  const entry = { id: "e1", ...row, revoked_at: null } as unknown as SuppressionEntry;
  const contact = { phone: "+573105551234", email: "ana@acme.co" };
  assert(pickSuppression([entry], "phone", contact), "llamadas: suprimido");
  assertEquals(pickSuppression([entry], "whatsapp", contact), null, "WhatsApp sigue abierto");
  assertEquals(pickSuppression([entry], "email", contact), null, "email sigue abierto");
});
