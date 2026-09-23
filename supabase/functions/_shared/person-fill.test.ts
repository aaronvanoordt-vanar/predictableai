import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { profileFillPatch } from "./person-fill.ts";

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
