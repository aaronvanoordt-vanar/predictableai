// deno test --allow-read supabase/functions/_shared/meeting-quality.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  attended, attributeMeeting, cleanReason, cleanVerdict, MIN_JUDGED, qualityInsights, VERDICT_LABEL, VERDICTS, type RatedMeeting,
} from "./meeting-quality.ts";

Deno.test("veredictos: válidos, borrar con null, el resto inválido", () => {
  assertEquals(cleanVerdict("qualified"), "qualified");
  assertEquals(cleanVerdict(null), null);
  assertEquals(cleanVerdict(""), null);
  assertEquals(cleanVerdict("ganada"), undefined);
  assertEquals(cleanReason("  muy   corto  "), "muy corto");
  assertEquals(cleanReason("x".repeat(400))!.length, 280);
  assertEquals(cleanReason("   "), null);
  assert(attended("not_qualified") && attended("held") && !attended("no_show") && !attended(null));
});

Deno.test("los espejos del navegador tienen los mismos veredictos y etiquetas", () => {
  for (const file of ["../../../js/portal-meetings.js", "../../../js/prospecting.js"]) {
    const src = Deno.readTextFileSync(new URL(file, import.meta.url));
    for (const v of VERDICTS) {
      assert(src.includes(`${v}: '${VERDICT_LABEL[v]}'`), `${file} debe tener ${v}: '${VERDICT_LABEL[v]}'`);
    }
  }
});

Deno.test("atribución: canal de la respuesta y ángulo del último envío aceptado antes de ella", () => {
  const ens = [
    { id: "a", member_id: "m1", replied_at: "2026-10-05T12:00:00Z", replied_channel: "whatsapp" },
    { id: "b", member_id: "m1", replied_at: null, replied_channel: null },
  ];
  const evs = [
    { enrollment_id: "a", node_id: "n1", channel: "email", type: "sent", provider_message_id: "p1", created_at: "2026-10-01T12:00:00Z" },
    { enrollment_id: "a", node_id: "n2", channel: "whatsapp", type: "sent", provider_message_id: "p2", created_at: "2026-10-04T12:00:00Z" },
    { enrollment_id: "a", node_id: "n3", channel: "whatsapp", type: "sent", provider_message_id: "p3", created_at: "2026-10-06T12:00:00Z" },
    { enrollment_id: "b", node_id: "x", channel: "email", type: "sent", provider_message_id: "p9", created_at: "2026-10-09T12:00:00Z" },
  ];
  const msgs = [{ enrollment_id: "a", node_id: "n2", angle: "dolor" }, { enrollment_id: "a", node_id: "n3", angle: "otro" }];
  assertEquals(attributeMeeting("m1", ens, evs, msgs), { channel: "whatsapp", angle: "dolor" });
  // Un envío fallido no cuenta.
  const failed = [...evs, { enrollment_id: "a", node_id: "n2", channel: "whatsapp", type: "failed", provider_message_id: "p2", created_at: "2026-10-04T12:01:00Z" }];
  assertEquals(attributeMeeting("m1", ens, failed, msgs), { channel: "whatsapp", angle: null });
  // Sin enrolamientos (reunión agendada a mano): sin canal ni ángulo.
  assertEquals(attributeMeeting("m2", ens, evs, msgs), { channel: null, angle: null });
});

Deno.test("calidad: calificada = éxito; no calificada y no se presentó = fracaso; «se dio» no juzga", () => {
  const rows: RatedMeeting[] = [
    ...Array(4).fill({ verdict: "qualified", channel: "whatsapp", country: "Mexico" }),
    { verdict: "not_qualified", channel: "whatsapp", country: "Mexico" },
    ...Array(5).fill({ verdict: "no_show", channel: "email", country: "Peru" }),
    ...Array(6).fill({ verdict: "held", channel: "linkedin_connect", country: "Chile" }),
  ];
  const out = qualityInsights(rows);
  const by = (k: string) => out.find((i) => i.key === k)!;
  assertEquals(by("channel:whatsapp").verdict, "works");
  assertEquals(by("channel:whatsapp").metrics.qualified_rate, 80);
  assertEquals(by("channel:email").verdict, "fails");
  assertEquals(by("channel:linkedin").verdict, "insufficient", "«se dio» sin calificar no alcanza para opinar");
  assertEquals(by("channel:linkedin").metrics.attendance_rate, 100);
  assertEquals(by("country:peru").label, "País: Peru");
  assertEquals(by("all").metrics.rated, rows.length);
  assert(out.every((i) => i.scope === "meeting_quality"));
});

Deno.test("sin volumen no hay veredicto, y sin reuniones no hay filas", () => {
  assertEquals(qualityInsights([]), []);
  const few = qualityInsights(Array(MIN_JUDGED - 1).fill({ verdict: "qualified", channel: "email" }));
  assertEquals(few.find((i) => i.key === "channel:email")!.verdict, "insufficient");
});
