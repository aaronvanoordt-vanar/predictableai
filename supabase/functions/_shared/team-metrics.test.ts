// deno test --allow-read _shared/team-metrics.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as tm from "./team-metrics.ts";

// El espejo del navegador se carga como script: deja window.TeamMetrics en globalThis.
await import("../../../js/team-metrics.js");
// deno-lint-ignore no-explicit-any
const js = (globalThis as any).TeamMetrics;

const DAY = 86400000;
// Miércoles 15 de octubre de 2026, 15:00 hora local.
const NOW = new Date(2026, 9, 15, 15, 0, 0).getTime();

function both<T>(fn: (m: typeof tm) => T): T {
  const a = fn(tm);
  // deno-lint-ignore no-explicit-any
  const b = fn(js as any);
  assertEquals(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)), "js/team-metrics.js difiere del TS");
  return a;
}

Deno.test("las métricas de meta coinciden con el CHECK de la migración y con el espejo", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261018000002_team_management.sql", import.meta.url));
  const check = sql.match(/metric\s+TEXT\s+NOT NULL CHECK \(metric IN \(([\s\S]*?)\)\)/);
  assert(check, "no encontré el CHECK de sales_team_goals.metric");
  const keys = [...check[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assertEquals(keys, tm.METRICS.map((m) => m.key));
  assertEquals(js.METRICS, tm.METRICS);
  assertEquals(js.RANK_SORTS, tm.RANK_SORTS);
  assertEquals([js.MIN_COHORT, js.MIN_PEERS, js.ON_TRACK_RATIO], [tm.MIN_COHORT, tm.MIN_PEERS, tm.ON_TRACK_RATIO]);
  // Cada métrica de meta la devuelve team_member_activity.
  for (const k of keys) assert(sql.includes(`'${k}', `), `team_member_activity no devuelve ${k}`);
});

Deno.test("periodBounds: semana de lunes a domingo, mes calendario y 30 días", () => {
  const w = both((m) => m.periodBounds("week", NOW));
  assertEquals(new Date(w.from).getDay(), 1);
  assertEquals(new Date(w.from).getDate(), 12);
  assertEquals(w.to - w.from >= 7 * DAY - 3600000, true);
  const prevW = both((m) => m.periodBounds("week", NOW, -1));
  assertEquals(prevW.to, w.from);
  const mo = both((m) => m.periodBounds("month", NOW));
  assertEquals([new Date(mo.from).getMonth(), new Date(mo.from).getDate()], [9, 1]);
  assertEquals([new Date(mo.to).getMonth(), new Date(mo.to).getDate()], [10, 1]);
  const d30 = both((m) => m.periodBounds("d30", NOW));
  assertEquals(new Date(d30.to).getDate(), 16);
  assertEquals(Math.round((d30.to - d30.from) / DAY), 30);
});

Deno.test("comparableBounds: el anterior cubre el mismo tramo transcurrido", () => {
  const c = both((m) => m.comparableBounds("week", NOW));
  assertEquals(c.current.to, NOW);
  assertEquals(c.previous.to - c.previous.from, c.current.to - c.current.from);
  assertEquals(c.previous.to <= c.current.from, true);
  const mo = both((m) => m.comparableBounds("month", NOW));
  assertEquals(new Date(mo.previous.from).getMonth(), 8);
  assertEquals(new Date(mo.previous.to).getDate(), 15);
  // Día 31 de un mes contra un mes de 30: no se pasa al mes siguiente.
  const late = new Date(2026, 9, 31, 20, 0, 0).getTime();
  const lm = both((m) => m.comparableBounds("month", late));
  assertEquals(lm.previous.to, new Date(2026, 9, 1).getTime());
});

Deno.test("goalProgress: ritmo, cumplida, sin dato y período cerrado", () => {
  const b = { from: NOW - 2 * DAY, to: NOW + 2 * DAY };
  const half = both((m) => m.goalProgress({ target: 10, actual: 5, from: b.from, to: b.to, now: NOW }));
  assertEquals([half.status, half.expected, half.pct, half.remaining], ["on_track", 5, 50, 5]);
  const behind = both((m) => m.goalProgress({ target: 10, actual: 2, from: b.from, to: b.to, now: NOW }));
  assertEquals(behind.status, "behind");
  const done = both((m) => m.goalProgress({ target: 10, actual: 12, from: b.from, to: b.to, now: NOW }));
  assertEquals([done.status, done.pct], ["done", 120]);
  const none = both((m) => m.goalProgress({ target: 10, actual: null, from: b.from, to: b.to, now: NOW }));
  assertEquals([none.status, none.pct], ["unavailable", null]);
  const closed = both((m) => m.goalProgress({ target: 10, actual: 9, from: b.from, to: NOW, now: NOW }));
  assertEquals(closed.status, "missed");
  // Al inicio del período con cero no está atrasado.
  const start = both((m) => m.goalProgress({ target: 10, actual: 0, from: NOW, to: NOW + 7 * DAY, now: NOW }));
  assertEquals(start.status, "on_track");
});

const row = (id: string, m: Record<string, number | null>) => ({ user_id: id, metrics: m });

Deno.test("rankTeam: el volumen vacío no gana y las tasas exigen muestra mínima", () => {
  const rows = [
    // Muchos envíos, ninguna reunión.
    row("a", { sent_total: 900, replies: 3, meetings_booked: 0, cohort: 800, cohort_replied: 3, cohort_meetings: 0 }),
    // Menos envíos, más reuniones.
    row("b", { sent_total: 150, replies: 20, meetings_booked: 5, cohort: 120, cohort_replied: 18, cohort_meetings: 5 }),
    // Tasa altísima sobre 3 personas.
    row("c", { sent_total: 3, replies: 2, meetings_booked: 1, cohort: 3, cohort_replied: 2, cohort_meetings: 1 }),
  ];
  const byMeetings = both((m) => m.rankTeam(rows, "meetings_booked"));
  assertEquals(byMeetings.map((r) => [r.user_id, r.rank]), [["b", 1], ["c", 2], ["a", 3]]);
  const byRate = both((m) => m.rankTeam(rows, "reply_rate"));
  assertEquals(byRate.map((r) => [r.user_id, r.rank, r.small_sample]), [["b", 1, false], ["a", 2, false], ["c", null, true]]);
  assertEquals(Math.round((byRate[0].reply_rate as number) * 100), 15);
});

Deno.test("rankTeam: empates comparten puesto", () => {
  const rows = [
    row("x", { meetings_booked: 2, replies: 4 }),
    row("y", { meetings_booked: 2, replies: 4 }),
    row("z", { meetings_booked: 1, replies: 9 }),
  ];
  const r = both((m) => m.rankTeam(rows, "meetings_booked"));
  assertEquals(r.map((x) => x.rank), [1, 1, 3]);
  const empty = both((m) => m.rankTeam([], "replies"));
  assertEquals(empty, []);
});

Deno.test("median", () => {
  assertEquals(both((m) => m.median([3, 1, 2])), 2);
  assertEquals(both((m) => m.median([4, 1, 2, 3])), 2.5);
  assertEquals(both((m) => m.median([])), null);
});

Deno.test("rampCompare: mediana de compañeros por semana cumplida, y avisa si no alcanza", () => {
  const wk = (week: number, complete: boolean, v: number | null) => ({ week, complete, metrics: { meetings_booked: v } });
  const subject = { weeks: [wk(1, true, 1), wk(2, true, 3), wk(3, false, 0)] };
  const peers = [
    { weeks: [wk(1, true, 0), wk(2, true, 2), wk(3, true, 4)] },
    { weeks: [wk(1, true, 2), wk(2, true, 2), wk(3, false, 9)] },
    { weeks: [wk(1, true, 1), wk(2, true, 4)] },
  ];
  const r = both((m) => m.rampCompare(subject, peers, "meetings_booked"));
  assertEquals(r.map((p) => [p.week, p.own, p.median, p.peers, p.enough, p.own_complete]), [
    [1, 1, 1, 3, true, true],
    [2, 3, 2, 3, true, true],
    [3, 0, null, 1, false, false],
  ]);
  // Llamadas sin telefonía: null, no cero.
  const calls = both((m) => m.rampCompare({ weeks: [{ week: 1, complete: true, metrics: { calls: null } }] }, peers, "calls"));
  assertEquals([calls[0].own, calls[0].peers, calls[0].median], [null, 0, null]);
});

Deno.test("delta: cantidades y puntos porcentuales", () => {
  assertEquals(both((m) => m.delta(5, 3)), 2);
  assertEquals(both((m) => m.delta(0.25, 0.2, true)), 5);
  assertEquals(both((m) => m.delta(null, 3)), null);
});
