/**
 * deno test supabase/functions/_shared/wati-history.test.ts
 *
 * Lo puro de la sincronización del historial de WATI: qué ítems del historial
 * son mensajes, en qué sentido, y cuándo uno ya está en la bandeja (por id o
 * por hora). Una regla floja aquí duplica cada mensaje del lead en la bandeja.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { historyIds, isKnown, parseHistoryItem } from "./wati-history.ts";

const base = {
  id: "507f1f77bcf86cd799439011",
  text: "Listo, ya te lo envié",
  type: "text",
  owner: true,
  status: "delivered",
  operator_name: "Aarón",
  local_message_id: "88aed3c93a050b3c53978463",
  created: "2026-10-01T14:32:00.000Z",
  conversation_id: "685bd235e6119686e693a093",
  event_type: "message",
};

Deno.test("parseHistoryItem: saliente de la UI de WATI", () => {
  const h = parseHistoryItem(base)!;
  assertEquals(h.direction, "out");
  assertEquals(h.body, "Listo, ya te lo envié");
  assertEquals(h.status, "delivered");
  assertEquals(h.operator, "Aarón");
  assertEquals(h.at, "2026-10-01T14:32:00.000Z");
});

Deno.test("parseHistoryItem: entrante del lead", () => {
  const h = parseHistoryItem({ ...base, owner: false, operator_name: null })!;
  assertEquals(h.direction, "in");
});

Deno.test("parseHistoryItem: eventos de ticket, notas y reacciones no son mensajes", () => {
  assertEquals(parseHistoryItem({ ...base, event_type: "ticket" }), null);
  assertEquals(parseHistoryItem({ ...base, event_type: "assignedOperator" }), null);
  assertEquals(parseHistoryItem({ ...base, type: "reaction" }), null);
  assertEquals(parseHistoryItem({ ...base, id: null }), null);
  assertEquals(parseHistoryItem({ ...base, created: "no-date", timestamp: null }), null);
});

Deno.test("parseHistoryItem: media sin texto se nombra; la URL del archivo no es texto", () => {
  const h = parseHistoryItem({ ...base, type: "image", text: "https://live-mt-server.wati.io/1/api/file/showFile?fileName=data/images/a.jpg" })!;
  assertEquals(h.body, "📷 Foto");
  assert(h.media);
});

Deno.test("isKnown: por id de WATI, wati:<id>, local id o WAMID", () => {
  const h = parseHistoryItem({ ...base, whatsapp_message_id: "wamid.X" })!;
  assert(historyIds(h).includes("wati:" + base.id));
  const far = "2026-09-01T00:00:00.000Z";
  assert(isKnown(h, [{ direction: "out", provider_message_id: base.id, sent_at: far, payload: {} }]));
  assert(isKnown(h, [{ direction: "out", provider_message_id: base.local_message_id, sent_at: far, payload: {} }]));
  assert(isKnown(h, [{ direction: "in", provider_message_id: "x", sent_at: far, payload: { wamid: "wamid.X" } }]));
  assert(isKnown(h, [{ direction: "out", provider_message_id: "y", sent_at: far, payload: { wati_message_id: base.id } }]));
});

Deno.test("isKnown: sin id común, mismo sentido a ±5 s (filas del webhook con solo WAMID)", () => {
  const h = parseHistoryItem({ ...base, owner: false })!;
  assert(isKnown(h, [{ direction: "in", provider_message_id: "wamid.OLD", sent_at: "2026-10-01T14:32:03.000Z", payload: {} }]));
  assert(!isKnown(h, [{ direction: "out", provider_message_id: "wamid.OLD", sent_at: "2026-10-01T14:32:03.000Z", payload: {} }]));
  assert(!isKnown(h, [{ direction: "in", provider_message_id: "wamid.OLD", sent_at: "2026-10-01T14:32:30.000Z", payload: {} }]));
});
