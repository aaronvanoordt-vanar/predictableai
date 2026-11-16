// deno test --allow-read _shared/meeting-alerts.test.ts
// Aviso de reunión desde el servidor: cuándo toca, que no se repita y que la
// clave sea la misma que usa la página (un solo aviso por reunión).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { alertKey, type AlertEvent, dueAlerts, LATE_MS, normalizeLead, pruneSent, pushPayload, SERVER_PUSH_ENABLED } from "./meeting-alerts.ts";

Deno.test("el aviso por push está apagado hasta confirmar la causa del cierre de Arc", () => {
  assertEquals(SERVER_PUSH_ENABLED, false);
});

const NOW = Date.parse("2026-11-16T15:00:00Z");
const ev = (minFromNow: number, over: Partial<AlertEvent> = {}): AlertEvent => ({
  provider: "google_calendar", id: "e1", title: "Demo", who: "Ana",
  start: new Date(NOW + minFromNow * 60_000).toISOString(),
  meeting_url: "https://meet.google.com/abc", ...over,
});

Deno.test("avisa dentro de la ventana: desde N minutos antes hasta 5 después", () => {
  assertEquals(dueAlerts([ev(3)], {}, 2, NOW).length, 0);
  assertEquals(dueAlerts([ev(2)], {}, 2, NOW).length, 1);
  assertEquals(dueAlerts([ev(0)], {}, 2, NOW).length, 1);
  assertEquals(dueAlerts([ev(-4)], {}, 2, NOW).length, 1);
  assertEquals(dueAlerts([ev(-6)], {}, 2, NOW).length, 0);
  assertEquals(dueAlerts([ev(8)], {}, 10, NOW).length, 1);
  assert(LATE_MS === 5 * 60_000);
});

Deno.test("no repite un aviso ya enviado ni avisa sin enlace de videollamada", () => {
  const e = ev(1);
  assertEquals(dueAlerts([e], { [alertKey(e)]: NOW - 1000 }, 2, NOW).length, 0);
  assertEquals(dueAlerts([ev(1, { meeting_url: "" })], {}, 2, NOW).length, 0);
  assertEquals(dueAlerts([ev(1, { meeting_url: "http://inseguro.test" })], {}, 2, NOW).length, 0);
  assertEquals(dueAlerts([ev(1, { start: "no-es-fecha" })], {}, 2, NOW).length, 0);
  assertEquals(dueAlerts(null, null, 2, NOW), []);
});

Deno.test("la clave es la de la página: proveedor, id y start tal cual", async () => {
  const e = ev(1);
  assertEquals(alertKey(e), `google_calendar:e1:${e.start}`);
  const js = await Deno.readTextFile(new URL("../../../js/coach-calendar.js", import.meta.url));
  assert(js.includes("function keyOf(ev) { return ev.provider + ':' + ev.id + ':' + ev.start; }"));
});

Deno.test("el aviso: título por minutos e idioma, acciones y enlace de vuelta", () => {
  assertEquals(pushPayload(ev(2), "es", NOW).title, "Tu reunión empieza en 2 minutos");
  assertEquals(pushPayload(ev(1), "es", NOW).title, "Tu reunión empieza en 1 minuto");
  assertEquals(pushPayload(ev(0), null, NOW).title, "Tu reunión ya empezó");
  assertEquals(pushPayload(ev(5), "en", NOW).title, "Your meeting starts in 5 minutes");
  assertEquals(pushPayload(ev(5), "pt-BR", NOW).title, "Sua reunião começa em 5 minutos");
  const p = pushPayload(ev(2), "es", NOW);
  assertEquals(p.kind, "coach-meeting");
  assertEquals(p.body, "Demo · Ana");
  assertEquals("actions" in p, false);   // notificación simple, sin botones
  assert(p.url.startsWith("/index.html?coach_event="));
  assertEquals(p.tag, "coach-" + p.key);
});

Deno.test("anticipación válida y limpieza del registro", () => {
  assertEquals(normalizeLead(5), 5);
  assertEquals(normalizeLead("10"), 10);
  assertEquals(normalizeLead(3), 2);
  assertEquals(normalizeLead(undefined), 2);
  assertEquals(pruneSent({ a: NOW - 3 * 86_400_000, b: NOW - 1000 }, NOW), { b: NOW - 1000 });
});
