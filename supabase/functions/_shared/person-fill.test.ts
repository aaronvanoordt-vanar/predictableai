import { assertEquals } from "jsr:@std/assert@1";
import { alignMatches, profileFillPatch } from "./person-fill.ts";

Deno.test("fills LinkedIn, location and company from the enriched person", () => {
  const row = { name: "Webert", title: "Founder & CEO", company: "ALTI Tecnologia", linkedin_url: null, country: null };
  const person = {
    linkedin_url: "http://www.linkedin.com/in/webert",
    title: "CEO",
    first_name: "Webert",
    last_name: "Silva",
    country: "Brazil",
    city: "São Paulo",
    state: "São Paulo",
    organization: { name: "ALTI", primary_domain: "altitecnologia.com" },
  };
  assertEquals(profileFillPatch(row, person), {
    linkedin_url: "http://www.linkedin.com/in/webert",
    first_name: "Webert",
    last_name: "Silva",
    country: "Brazil",
    city: "São Paulo",
    state: "São Paulo",
    company_domain: "altitecnologia.com",
  });
});

Deno.test("never overwrites what the row already has", () => {
  const row = { linkedin_url: "https://linkedin.com/in/manual", country: "Mexico" };
  assertEquals(profileFillPatch(row, { linkedin_url: "http://linkedin.com/in/other", country: "Chile" }), {});
});

Deno.test("no person, no patch", () => {
  assertEquals(profileFillPatch({}, null), {});
  assertEquals(profileFillPatch({}, { linkedin_url: "  " }), {});
});

Deno.test("profileFillPatch: el nombre completo reemplaza al parcial u ofuscado", () => {
  const person = { first_name: "Juan", last_name: "Pérez Gómez", name: "Juan Pérez Gómez" };
  assertEquals(profileFillPatch({ name: "Juan", first_name: "Juan" }, person), {
    last_name: "Pérez Gómez", name: "Juan Pérez Gómez",
  });
  assertEquals(profileFillPatch({ name: "Juan Pé***", first_name: "Juan", last_name: "Pé***" }, person), {
    name: "Juan Pérez Gómez", last_name: "Pérez Gómez", first_name: "Juan",
  });
});

Deno.test("profileFillPatch: un nombre distinto del usuario no se pisa", () => {
  const person = { first_name: "Juan", last_name: "Pérez", name: "Juan Pérez" };
  assertEquals(profileFillPatch({ name: "Juanito P.", first_name: "Juanito", last_name: "P." }, person), {});
});

Deno.test("alignMatches: empareja por id aunque Apollo omita a alguien", () => {
  const out = alignMatches(["a", "b", "c"], [{ id: "a", name: "A" }, { id: "c", name: "C" }]);
  assertEquals(out.map((m) => m && m.name), ["A", null, "C"]);
});
