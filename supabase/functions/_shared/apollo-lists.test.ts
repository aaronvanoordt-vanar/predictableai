/**
 * deno test supabase/functions/_shared/apollo-lists.test.ts
 *
 * Las listas de Apollo solo se leen para la cuenta habilitada, con su propio
 * Apollo, y solo salen ids para excluir.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  APOLLO_LISTS_USER_IDS,
  apolloListsAllowed,
  sanitizeContactsSearch,
  sanitizeContactsSearchBody,
  sanitizeLabels,
} from "./apollo-lists.ts";

const ALLOWED = [...APOLLO_LISTS_USER_IDS][0];
const LABEL = "6095a710bd01d100a506d4ae";

Deno.test("solo la cuenta habilitada y nunca con la key compartida", () => {
  assert(apolloListsAllowed(ALLOWED, "oauth"));
  assert(apolloListsAllowed(ALLOWED, "user_key"));
  assert(!apolloListsAllowed(ALLOWED, "platform"));
  assert(!apolloListsAllowed("00000000-0000-0000-0000-000000000000", "oauth"));
});

Deno.test("la búsqueda de contactos solo admite listas y página", () => {
  assertEquals(
    sanitizeContactsSearchBody({ contact_label_ids: [LABEL, LABEL, "x"], page: 3, per_page: 5, q_keywords: "ceo" }),
    { contact_label_ids: [LABEL], page: 3, per_page: 100 },
  );
  assertEquals(sanitizeContactsSearchBody({ contact_label_ids: [LABEL], page: 9999 })?.page, 1);
  assertEquals(sanitizeContactsSearchBody({}), null);
  assertEquals(sanitizeContactsSearchBody({ contact_label_ids: ["../x"] }), null);
});

Deno.test("solo listas de contactos, con id, nombre y conteo", () => {
  const out = sanitizeLabels([
    { id: "b", name: "Zeta", modality: "contacts", cached_count: 12, user_id: "u" },
    { id: "a", name: "Alfa", modality: "contacts", cached_count: "3" },
    { id: "c", name: "Cuentas", modality: "accounts", cached_count: 9 },
  ]);
  assertEquals(out, { labels: [{ id: "a", name: "Alfa", count: 3 }, { id: "b", name: "Zeta", count: 12 }] });
  assertEquals(sanitizeLabels({ labels: [{ id: "x", name: "" }] }), { labels: [{ id: "x", name: "Lista sin nombre", count: null }] });
});

Deno.test("los contactos salen solo como ids", () => {
  const out = sanitizeContactsSearch({
    contacts: [{ id: "c1", person_id: "p1", email: "a@b.com", phone_numbers: [{}] }, { id: "c2" }, {}],
    pagination: { page: 2, total_pages: 4, total_entries: 350 },
  });
  assertEquals(out, {
    contacts: [{ id: "c1", person_id: "p1" }, { id: "c2", person_id: null }],
    pagination: { page: 2, total_pages: 4, total_entries: 350 },
  });
});
