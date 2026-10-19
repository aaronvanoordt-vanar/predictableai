// deno test supabase/functions/_shared/contact-rules.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  checkContactRules, colombiaHolidays, startOfDay, COUNTRY_RULES, countryRuleFor, dayKey, easterSunday, isAllowed, leadCountry, nextAllowed,
} from "./contact-rules.ts";

const CO = COUNTRY_RULES.CO;
// Colombia = UTC-5 todo el año.
const bogota = (s: string) => new Date(s + "-05:00");

Deno.test("Pascua", () => {
  assertEquals(easterSunday(2026), { month: 4, day: 5 });
  assertEquals(easterSunday(2027), { month: 3, day: 28 });
  assertEquals(easterSunday(2025), { month: 4, day: 20 });
});

Deno.test("festivos de Colombia 2026 (18, con Ley Emiliani)", () => {
  assertEquals(colombiaHolidays(2026), [
    "2026-01-01", "2026-01-12", "2026-03-23", "2026-04-02", "2026-04-03", "2026-05-01", "2026-05-18",
    "2026-06-08", "2026-06-15", "2026-06-29", "2026-07-20", "2026-08-07", "2026-08-17", "2026-10-12",
    "2026-11-02", "2026-11-16", "2026-12-08", "2026-12-25",
  ]);
  assertEquals(colombiaHolidays(2027).length, 18);
});

Deno.test("país del lead: campo country o prefijo +57", () => {
  assertEquals(leadCountry({ country: "Colombia" }), "CO");
  assertEquals(leadCountry({ country: "CO" }), "CO");
  assertEquals(leadCountry({ country: "Mexico", phone: "+57 300 123 4567" }), null); // el país declarado manda
  assertEquals(leadCountry({ phone: "+57 300 123 4567" }), "CO");
  assertEquals(leadCountry({ phone: "+57 601 234 5678" }), "CO");
  assertEquals(leadCountry({ phone: "+52 55 1234 5678" }), null);
  assertEquals(leadCountry({}), null);
  assertEquals(countryRuleFor({ country: "Perú" }), null);
});

Deno.test("horario de la Ley 2300", () => {
  assert(isAllowed(CO, bogota("2026-10-20T07:00:00"))); // martes
  assert(isAllowed(CO, bogota("2026-10-20T18:59:00")));
  assert(!isAllowed(CO, bogota("2026-10-20T19:00:00")));
  assert(!isAllowed(CO, bogota("2026-10-20T06:59:00")));
  assert(isAllowed(CO, bogota("2026-10-24T08:00:00"))); // sábado
  assert(!isAllowed(CO, bogota("2026-10-24T15:00:00")));
  assert(!isAllowed(CO, bogota("2026-10-25T10:00:00"))); // domingo
  assert(!isAllowed(CO, bogota("2026-10-12T10:00:00"))); // festivo (lunes)
});

Deno.test("siguiente momento permitido", () => {
  // Sábado 15:30 → lunes 26 a las 7:00 (domingo en medio).
  assertEquals(nextAllowed(CO, bogota("2026-10-24T15:30:00")).toISOString(), bogota("2026-10-26T07:00:00").toISOString());
  // Domingo antes del festivo del lunes 12 → martes 13 a las 7:00.
  assertEquals(nextAllowed(CO, bogota("2026-10-11T12:00:00")).toISOString(), bogota("2026-10-13T07:00:00").toISOString());
  // Semana Santa 2026: miércoles 1 a las 20:00 → sábado 4 a las 8:00.
  assertEquals(nextAllowed(CO, bogota("2026-04-01T20:00:00")).toISOString(), bogota("2026-04-04T08:00:00").toISOString());
  // Dentro de la ventana: el mismo instante.
  const now = bogota("2026-10-20T10:17:00");
  assertEquals(nextAllowed(CO, now).getTime(), now.getTime());
});

Deno.test("checkContactRules: sin regla, ventana y un envío por día", () => {
  assertEquals(checkContactRules(null, bogota("2026-10-25T03:00:00"), 9), { ok: true });
  assertEquals(checkContactRules(CO, bogota("2026-10-20T10:00:00"), 0), { ok: true });

  const night = checkContactRules(CO, bogota("2026-10-20T21:00:00"), 0);
  assert(!night.ok);
  assertEquals(night.retryAt!.toISOString(), bogota("2026-10-21T07:00:00").toISOString());
  assert(/Ley 2300/.test(night.reason!) && /fuera del horario/.test(night.reason!));

  // Ya recibió uno hoy a las 9: el siguiente sale mañana a las 7.
  const cap = checkContactRules(CO, bogota("2026-10-20T11:00:00"), 1);
  assert(!cap.ok);
  assertEquals(cap.retryAt!.toISOString(), bogota("2026-10-21T07:00:00").toISOString());
  assert(/ya recibió un envío hoy/.test(cap.reason!));
  // Viernes con tope cumplido → sábado a las 8.
  assertEquals(checkContactRules(CO, bogota("2026-10-23T11:00:00"), 1).retryAt!.toISOString(), bogota("2026-10-24T08:00:00").toISOString());
});

Deno.test("dayKey usa el día de Colombia, no el UTC", () => {
  assertEquals(dayKey(CO, new Date("2026-10-21T03:00:00Z")), "2026-10-20");
});

Deno.test("startOfDay = medianoche de Colombia", () => {
  assertEquals(startOfDay(CO, bogota("2026-10-20T15:40:00")).toISOString(), bogota("2026-10-20T00:00:00").toISOString());
});
