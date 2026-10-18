// deno test supabase/functions/_shared/benchmarks.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  BENCHMARK_CSV_COLUMNS, hasAnyRate, INSUFFICIENT, maskCell, mergeCells, MIN_ACCOUNTS, MIN_CONTACTS, MIN_MEETINGS,
  normalizeCountry, parseBenchmarkCsv, parseCsv, type Cell,
} from "./benchmarks.ts";

const cell = (o: Partial<Cell>): Cell => ({
  source: "platform", country: "mexico", industry: "", accounts: 5, contacts: 1000, replied: 80, meetings: 30,
  attended: 24, no_show: 6, qualified: 12, judged: 20, ...o,
});

Deno.test("con volumen, las tasas salen sobre personas", () => {
  const m = maskCell(cell({}));
  assertEquals(m.reply_rate.value, 8);
  assertEquals(m.meeting_rate.value, 3);
  assertEquals(m.attendance_rate.value, 80);
  assertEquals(m.qualified_rate.value, 60);
  assertEquals(m.contacts, 1000);
});

Deno.test("por debajo del mínimo: «sin datos suficientes» y sin conteos crudos", () => {
  const fewAccounts = maskCell(cell({ accounts: MIN_ACCOUNTS - 1 }));
  assertEquals(fewAccounts.reply_rate, { value: null, note: INSUFFICIENT });
  assertEquals(fewAccounts.attendance_rate.value, null);
  assertEquals(fewAccounts.contacts, null);
  assertEquals(hasAnyRate(fewAccounts), false);

  const fewContacts = maskCell(cell({ contacts: MIN_CONTACTS - 1 }));
  assertEquals(fewContacts.reply_rate.value, null);
  assertEquals(fewContacts.attendance_rate.value, 80, "la asistencia tiene su propio mínimo");

  const fewMeetings = maskCell(cell({ attended: MIN_MEETINGS - 2, no_show: 1, judged: 3 }));
  assertEquals(fewMeetings.attendance_rate.value, null);
  assertEquals(fewMeetings.qualified_rate.value, null);
  assertEquals(fewMeetings.reply_rate.value, 8);
});

Deno.test("mergeCells suma plataforma e histórico de la misma celda", () => {
  const all = mergeCells([cell({ accounts: 2, contacts: 150 }), cell({ source: "eleva", accounts: 2, contacts: 100 })]);
  assertEquals(all.length, 1);
  assertEquals(all[0].accounts, 4);
  assertEquals(maskCell(all[0]).contacts, 250);
});

Deno.test("CSV: coma o punto y coma, comillas, BOM", () => {
  assertEquals(parseCsv('﻿a;b\n"x;1";"di ""y"""\n'), [["a", "b"], ["x;1", 'di "y"']]);
  assertEquals(parseCsv("a,b\r\n1,2\r\n\r\n"), [["a", "b"], ["1", "2"]]);
});

const HEADER = BENCHMARK_CSV_COLUMNS.map((c) => c.key).join(",");

Deno.test("importador: filas válidas normalizadas a la taxonomía de la plataforma", () => {
  const csv = HEADER + "\n" +
    "2024-03,México,Financial Services,whatsapp,4,1200,96,30,24,6,15\n" +
    '2024-04,Perú,"information technology & services",email,3,800,40,12,10,2,\n';
  const r = parseBenchmarkCsv(csv);
  assertEquals(r.errors, []);
  assertEquals(r.rows.length, 2);
  assertEquals(r.rows[0], {
    period_month: "2024-03-01", country: "mexico", industry: "financial services", channel: "whatsapp",
    clients: 4, contacts: 1200, replied: 96, meetings_booked: 30, meetings_held: 24, no_shows: 6, meetings_qualified: 15,
  });
  assertEquals(r.rows[1].meetings_qualified, null);
  assertEquals(normalizeCountry("Republica Dominicana"), "dominican republic");
});

Deno.test("importador: errores por línea, nada a medias", () => {
  const csv = HEADER + "\n" +
    "2024-13,Narnia,fintech,fax,0,10,20,30,40,5,50\n" +
    "2024-03,Chile,banking,email,2,100,10,5,4,3,\n";
  const r = parseBenchmarkCsv(csv);
  assertEquals(r.rows.length, 0);
  assertEquals(r.errors.map((e) => e.line), [2, 3]);
  assert(r.errors[0].message.includes("period_month"));
  assert(r.errors[0].message.includes("Narnia"));
  assert(r.errors[1].message.includes("meetings_held + no_shows"));
  assertEquals(parseBenchmarkCsv("period_month,country\n2024-01,Chile").errors[0].message, "Falta la columna «industry».");
  assert(parseBenchmarkCsv(HEADER + ",email_del_lead\n").errors.some((e) => e.message.includes("email_del_lead")), "una columna de personas se rechaza");
});

Deno.test("la plantilla CSV del navegador es el mismo esquema", () => {
  const src = Deno.readTextFileSync(new URL("../../../js/benchmarks.js", import.meta.url));
  assert(src.includes(`var CSV_HEADER = '${HEADER}';`), "CSV_HEADER de js/benchmarks.js debe coincidir con BENCHMARK_CSV_COLUMNS");
  const doc = Deno.readTextFileSync(new URL("../../../docs/BENCHMARKS.md", import.meta.url));
  for (const c of BENCHMARK_CSV_COLUMNS) assert(doc.includes("`" + c.key + "`"), `docs/BENCHMARKS.md documenta ${c.key}`);
});
