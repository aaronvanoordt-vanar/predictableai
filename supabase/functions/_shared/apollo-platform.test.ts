/**
 * deno test supabase/functions/_shared/apollo-platform.test.ts
 *
 * Con la key compartida de la plataforma, un cliente no puede ver lo que otro
 * guardó en esa cuenta de Apollo (contactos, emails revelados, etiquetas).
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { blockedInPlatformMode, contactAsPerson, contactIdsFromOtherAccount, sanitizePlatformSearch } from "./apollo-platform.ts";

Deno.test("POST /contacts no llega a la cuenta compartida", () => {
  assert(blockedInPlatformMode("/contacts"));
  assert(!blockedInPlatformMode("/mixed_people/api_search"));
  assert(!blockedInPlatformMode("/people/bulk_match"));
});

Deno.test("un contacto guardado por otro cliente sale sin email, teléfono ni etiquetas", () => {
  const p = contactAsPerson({
    id: "c1",
    person_id: "p1",
    first_name: "Ana",
    last_name: "Pérez",
    title: "CFO",
    organization_name: "Acme",
    email: "ana@acme.com",
    email_status: "verified",
    phone_numbers: [{ sanitized_number: "+5215555555555" }],
    label_ids: ["l1"],
    linkedin_url: "https://linkedin.com/in/ana",
  });
  assertEquals(p, {
    id: "p1",
    first_name: "Ana",
    last_name_obfuscated: "P***",
    title: "CFO",
    organization: { name: "Acme" },
  });
});

Deno.test("sin person_id el contacto se descarta", () => {
  assertEquals(contactAsPerson({ id: "c1", email: "x@y.com" }), null);
});

Deno.test("la búsqueda no devuelve contacts y no duplica personas", () => {
  const out = sanitizePlatformSearch({
    contacts: [
      { id: "c1", person_id: "p1", first_name: "Ana", email: "ana@acme.com" },
      { id: "c2", person_id: "p2", first_name: "Luis" },
      { id: "c3", email: "sin@person.id" },
    ],
    people: [{ id: "p2", first_name: "Luis" }, { id: "p3", first_name: "Eva" }],
    pagination: { page: 1, total_entries: 5 },
  }) as Record<string, unknown>;
  assertEquals(out.contacts, []);
  const people = out.people as Record<string, unknown>[];
  assertEquals(people.map((p) => p.id), ["p1", "p2", "p3"]);
  assert(!JSON.stringify(out).includes("@"));
  assertEquals(out.pagination, { page: 1, total_entries: 5 });
});

Deno.test("respuestas raras pasan tal cual", () => {
  assertEquals(sanitizePlatformSearch(null), null);
  assertEquals(sanitizePlatformSearch([1]), [1]);
});

Deno.test("los contactos se olvidan al pasar a otra cuenta de Apollo, no al reconectar la misma", () => {
  assert(contactIdsFromOtherAccount(null, "u1"), "primera conexión: venían de la cuenta compartida");
  assert(contactIdsFromOtherAccount({}, "u1"));
  assert(contactIdsFromOtherAccount({ apollo_user_id: "u1" }, "u2"), "cambió de cuenta");
  assert(!contactIdsFromOtherAccount({ apollo_user_id: "u1" }, "u1"), "reconectó la misma");
  assert(!contactIdsFromOtherAccount({ apollo_user_id: 7 }, "7"));
  assert(contactIdsFromOtherAccount({ apollo_user_id: "u1" }, null), "sin id nuevo no se puede probar que sea la misma");
});
