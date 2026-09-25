/**
 * deno test supabase/functions/_shared/dripify.test.ts
 *
 * Cubre el parser del hilo del webhook de campaña de Dripify. El payload de
 * `REAL` es uno de producción (2026-09-12, lead de LinkedIn con respuestas),
 * recortado solo en los campos que no usa el parser.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { conversationMessageId, linkedinSlug, parseConversation } from "./dripify.ts";

const REAL = {
  city: "La Plata",
  link: "https://www.linkedin.com/in/jmsoerensen",
  company: "APM Terminals Buenos Aires",
  lastName: "Muñoz Soerensen",
  firstName: "Jorge Alejandro",
  campaignName: "Predictable AI - 3 Modules",
  conversation: [
    {
      text: "Hola Jorge Alejandro! Te escribo porque he construido Predictable AI.",
      type: "Linkedin message sent",
      userName: "Aarón van Oordt",
      timestamp: "2026-09-11T15:10:31.404Z",
    },
    {
      text: "Te agradezco! No estoy en ventas",
      type: "Linkedin message replied",
      userName: "Jorge Alejandro Muñoz Soerensen",
      timestamp: "2026-09-12T15:26:48.812Z",
    },
    {
      text: "Muchos éxitos",
      type: "Linkedin message replied",
      userName: "Jorge Alejandro Muñoz Soerensen",
      timestamp: "2026-09-12T15:26:53.845Z",
    },
  ],
};

Deno.test("parseConversation lee texto, dirección y hora del hilo real", () => {
  const out = parseConversation(REAL, "Jorge Munoz Soerensen");
  assertEquals(out.length, 3);
  assertEquals(out.map((e) => e.direction), ["out", "in", "in"]);
  assertEquals(out[1].text, "Te agradezco! No estoy en ventas");
  assertEquals(out[0].at, "2026-09-11T15:10:31.404Z");
  assertEquals(out[2].userName, "Jorge Alejandro Muñoz Soerensen");
});

Deno.test("parseConversation ordena del más antiguo al más nuevo", () => {
  const shuffled = { conversation: [REAL.conversation[2], REAL.conversation[0], REAL.conversation[1]] };
  const out = parseConversation(shuffled);
  assertEquals(out.map((e) => e.text), [
    REAL.conversation[0].text,
    REAL.conversation[1].text,
    REAL.conversation[2].text,
  ]);
});

Deno.test("parseConversation cae al nombre cuando el tipo no dice la dirección", () => {
  const payload = {
    conversation: [
      { text: "Hola", type: "linkedin_message", userName: "Aarón van Oordt", timestamp: "2026-09-11T10:00:00.000Z" },
      { text: "Contame más", type: "linkedin_message", userName: "Jorge Muñoz", timestamp: "2026-09-11T11:00:00.000Z" },
    ],
  };
  assertEquals(parseConversation(payload, "Jorge Munoz Soerensen").map((e) => e.direction), ["out", "in"]);
});

Deno.test("parseConversation tolera otros nombres de campo y anidación", () => {
  const payload = {
    lead: { profile: "https://www.linkedin.com/in/x" },
    data: { messages: [{ body: "Respondo esto", event: "reply received", sender: "Otra Persona", createdAt: "2026-09-11T10:00:00Z" }] },
  };
  const out = parseConversation(payload);
  assertEquals(out.length, 1);
  assertEquals(out[0].direction, "in");
  assertEquals(out[0].text, "Respondo esto");
  assertEquals(out[0].at, "2026-09-11T10:00:00.000Z");
});

Deno.test("parseConversation devuelve vacío sin hilo, y salta mensajes sin texto", () => {
  assertEquals(parseConversation({ event: "invite accepted", link: "https://www.linkedin.com/in/x" }), []);
  assertEquals(parseConversation({ conversation: [{ type: "Linkedin message sent", userName: "Aarón" }] }), []);
});

Deno.test("conversationMessageId es estable y distingue cuenta, perfil e instante", () => {
  const [first, second] = parseConversation(REAL, "Jorge Munoz Soerensen");
  const id = conversationMessageId("user-1", linkedinSlug(REAL.link), first, 0);
  assertEquals(id, "conv:user-1:jmsoerensen:2026-09-11T15:10:31.404Z");
  assertEquals(conversationMessageId("user-1", linkedinSlug(REAL.link), first, 0), id);
  assertEquals(conversationMessageId("user-2", linkedinSlug(REAL.link), first, 0) === id, false);
  assertEquals(conversationMessageId("user-1", linkedinSlug(REAL.link), second, 1) === id, false);
  // Sin hora utilizable cae al índice, que también es estable (el hilo llega
  // ordenado del más antiguo al más nuevo).
  const noDate = { ...first, at: null };
  assertEquals(conversationMessageId("user-1", "jmsoerensen", noDate, 0), "conv:user-1:jmsoerensen:i0");
});
