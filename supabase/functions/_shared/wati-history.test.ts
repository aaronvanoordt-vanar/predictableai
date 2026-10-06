/**
 * deno test supabase/functions/_shared/wati-history.test.ts
 *
 * Lo puro de la sincronización del historial de WATI: qué ítems del historial
 * son mensajes, en qué sentido, y cuándo uno ya está en la bandeja (por id o
 * por hora). Una regla floja aquí duplica cada mensaje del lead en la bandeja.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { historyIds, isKnown, matchCampaignSend, parseHistoryItem, sameBody, visitOrder } from "./wati-history.ts";

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

Deno.test("visitOrder: el cursor sigue donde quedó sin dejar de mirar las más recientes", () => {
  assertEquals(visitOrder(8, 0), [0, 1, 2, 3, 4, 5, 6, 7]);
  assertEquals(visitOrder(10, 7), [0, 1, 2, 3, 4, 7, 8, 9]);
  assertEquals(visitOrder(10, 3), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assertEquals(visitOrder(10, 12), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // la lista se achicó: se empieza de nuevo
});

// Forma real de /api/ext/v3/conversations/{phone}/messages para una plantilla
// de campaign-run (2026-10-06): sin `owner`, sin `text`, sin local_message_id.
const broadcast = {
  final_text: "Hola Alfonso! Te saluda Aarón van Oordt, CEO de Vanar y Business Partner de Botmaker. Qué tal todo?",
  failed_detail: "OAuthException! (#132001) Template name does not exist in the translation",
  status_string: "FAILED",
  id: "6ac51b8464407f07c1f288ff",
  created: "2026-10-06T16:02:13.509Z",
  conversation_id: "6ac51b841024183cad4e3301",
  event_type: "broadcastMessage",
};
const campaignRow = {
  direction: "out",
  provider_message_id: "e1610741-143b-4042-8ced-58c92205aa5c",
  sent_at: "2026-10-06T16:02:00.932Z",
  body: "Hola Alfonso! Te saluda Aarón van Oordt, CEO de Vanar y Business Partner de Botmaker. Qué tal todo?",
  payload: { node_id: "nbdjdh29b" },
};

Deno.test("parseHistoryItem: plantilla de difusión = saliente con su falla de Meta", () => {
  const h = parseHistoryItem(broadcast)!;
  assertEquals(h.direction, "out");
  assert(h.broadcast);
  assert(!parseHistoryItem(base)!.broadcast);
  assertEquals(h.status, "failed");
  assertEquals(h.failedDetail, broadcast.failed_detail);
  assert(h.body.startsWith("Hola Alfonso!"));
  assertEquals(parseHistoryItem({ ...broadcast, status_string: "READ", failed_detail: "" })!.status, "read");
});

Deno.test("matchCampaignSend: por texto dentro de la ventana de la corrida", () => {
  const h = parseHistoryItem(broadcast)!;
  assertEquals(matchCampaignSend(campaignRow, [h])?.watiId, broadcast.id);
  // Ya reclamado por otra fila: no se reparte dos veces.
  assertEquals(matchCampaignSend(campaignRow, [h], new Set([broadcast.id])), null);
  // Fuera de la ventana (un saludo de otro día con el mismo texto): no es este envío.
  const old = parseHistoryItem({ ...broadcast, created: "2026-10-05T16:02:13.509Z" })!;
  assertEquals(matchCampaignSend(campaignRow, [old]), null);
  // Por id de WATI guardado en la fila, aunque la hora no calce.
  assertEquals(matchCampaignSend({ ...campaignRow, payload: { wati_id: broadcast.id } }, [old])?.watiId, broadcast.id);
});

Deno.test("matchCampaignSend: un solo saliente en la ventana con otro texto (encabezado) también vale", () => {
  const h = parseHistoryItem({ ...broadcast, final_text: "Texto distinto" })!;
  assertEquals(matchCampaignSend(campaignRow, [h])?.watiId, broadcast.id);
  const h2 = parseHistoryItem({ ...broadcast, id: "otro", final_text: "Otro distinto" })!;
  assertEquals(matchCampaignSend(campaignRow, [h, h2]), null); // ambiguo: no se adivina
});

Deno.test("isKnown: la plantilla de campaña ya guardada no entra otra vez como «desde WATI»", () => {
  const h = parseHistoryItem(broadcast)!;
  assert(isKnown(h, [campaignRow]));
  assert(!isKnown(h, [{ ...campaignRow, body: "Otro mensaje" }]));
});

Deno.test("sameBody: espacios y encabezados no rompen la coincidencia", () => {
  assert(sameBody(" \n\n Hola Guillermo, te saluda", "Hola Guillermo, te saluda"));
  assert(!sameBody("", "Hola"));
});
