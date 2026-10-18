// deno test --allow-read _shared/phone-lines.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import {
  apolloPhoneType, lineType, noWhatsappCode, reachKey, reachSummary, whatsappReach,
} from "./phone-lines.ts";
import { countryIso, normalizePhone, providerPhoneType, whatsappCapable } from "./phone-latam.ts";

const kind = (phone: string, country?: string, type?: string) => lineType(phone, country, type).kind;

// El tipo de línea es el del normalizador del waterfall (phone-latam.ts): estos
// casos fijan lo que el motor hace con cada uno antes de mandar una plantilla.
Deno.test("México: el 52 1 delata un celular; 10 dígitos no dicen nada; 800 es de empresa", () => {
  assertEquals(kind("+5215512345678"), "mobile");
  assertEquals(kind("+525512345678"), "unknown");
  assertEquals(kind("5512345678", "Mexico"), "unknown");
  assertEquals(kind("+528001234567"), "switchboard");
  assertEquals(kind("+525512345678", undefined, "work_hq"), "switchboard");
  assertEquals(kind("+525512345678", undefined, "mobile"), "mobile");
});

Deno.test("Colombia, Chile, Perú: el plan de numeración decide", () => {
  assertEquals(kind("+57 300 123 4567"), "mobile");
  assertEquals(kind("+57 601 234 5678"), "landline");
  assertEquals(kind("+57 1 234 5678"), "landline");
  assertEquals(kind("01 8000 123456", "Colombia"), "switchboard");
  assertEquals(kind("+56 9 8765 4321"), "mobile");
  assertEquals(kind("+56 2 2421 3146"), "landline");
  assertEquals(kind("+51 987 654 321"), "mobile");
  assertEquals(kind("01 234 5678", "Perú"), "landline");
});

Deno.test("Argentina y Brasil", () => {
  assertEquals(kind("+54 9 11 2345 6789"), "mobile");
  assertEquals(kind("+54 11 2345 6789"), "unknown");
  assertEquals(kind("011 15 2345 6789", "Argentina"), "mobile");
  assertEquals(kind("+55 11 98765 4321"), "mobile");
  assertEquals(kind("+55 11 3456 7890"), "landline");
  assertEquals(kind("+55 21 8765 4321"), "mobile");
  assertEquals(kind("5133334444", "Brasil"), "landline");
});

Deno.test("sin datos: se envía igual", () => {
  assertEquals(kind("+1 415 555 0100"), "unknown");
  assertEquals(kind("123"), "unknown");
  assertEquals(whatsappReach({ phone: "+1 415 555 0100" }).send, true);
});

Deno.test("reachKey: 52 1 / 54 9 son el mismo número que 52 / 54", () => {
  assertEquals(reachKey("+5215512345678"), reachKey("+525512345678"));
  assertEquals(reachKey("+5491123456789"), "541123456789");
  assertEquals(reachKey("0057 300 123 4567"), "573001234567");
});

Deno.test("apolloPhoneType lee el tipo de ESE número en el snapshot", () => {
  const snap = { phone_numbers: [{ sanitized_number: "+525511112222", type: "work_hq" }, { sanitized_number: "+5215533334444", type: "mobile" }] };
  assertEquals(apolloPhoneType(snap, "+52 55 1111 2222"), "work_hq");
  assertEquals(apolloPhoneType(snap, "+52 55 3333 4444"), "mobile");
  assertEquals(apolloPhoneType(snap, "+52 55 9999 0000"), null);
  assertEquals(apolloPhoneType(null, "+52"), null);
});

Deno.test("noWhatsappCode: 131026 y el texto de número no registrado; no confunde otros códigos", () => {
  assertEquals(noWhatsappCode("(#131026) Message Undeliverable."), "131026");
  assertEquals(noWhatsappCode("Receiver is not a valid WhatsApp user"), "not_on_whatsapp");
  assertEquals(noWhatsappCode("Invalid WhatsApp number"), "not_on_whatsapp");
  assertEquals(noWhatsappCode("Message Undeliverable"), "not_on_whatsapp"); // el historial de WATI a veces trae solo el título de #131026
  assertEquals(noWhatsappCode("#131037 display name not approved"), null);
  assertEquals(noWhatsappCode("#1310260"), null);
  assertEquals(noWhatsappCode("#132001 template does not exist"), null);
  assertEquals(noWhatsappCode(null), null);
});

Deno.test("whatsappReach: lo aprendido manda sobre el tipo de línea; ante la duda se envía", () => {
  const mxUnknown = "+525512345678";
  assertEquals(whatsappReach({ phone: "" }).status, "no_phone");
  assertEquals(whatsappReach({ phone: mxUnknown, learned: { status: "no_whatsapp", code: "131026" } }).send, false);
  assertEquals(whatsappReach({ phone: "+57 601 234 5678", learned: { status: "has_whatsapp" } }).status, "confirmed");
  assertEquals(whatsappReach({ phone: "+57 601 234 5678" }), {
    status: "fixed", label: "Fijo", send: false,
    reason: "Fijo de Colombia según su plan de numeración o el proveedor. Un fijo no recibe la plantilla.",
  });
  assertEquals(whatsappReach({ phone: mxUnknown, providerType: "work_hq" }).status, "switchboard");
  assertEquals(whatsappReach({ phone: mxUnknown, providerType: "switchboard" }).send, false); // phone_type guardado por el waterfall
  assertEquals(whatsappReach({ phone: mxUnknown, providerType: "mobile" }).status, "probable");
  assertEquals(whatsappReach({ phone: mxUnknown }), { status: "unknown", label: "Por confirmar", send: true, reason: lineType(mxUnknown).reason });
  assertEquals(whatsappReach({ phone: mxUnknown, learned: { status: "no_whatsapp", code: "not_on_whatsapp" } }).reason.includes("#"), false);
});

Deno.test("el veredicto coincide con whatsappCapable del waterfall en números válidos", () => {
  for (const p of ["+5215512345678", "+525512345678", "+57 601 234 5678", "+57 300 123 4567", "+56 2 2421 3146", "+55 11 98765 4321", "+52 55 5000 1000 ext. 214"]) {
    assertEquals(whatsappReach({ phone: p }).send, whatsappCapable(normalizePhone(p)), p);
  }
});

Deno.test("reachSummary cuenta y estima las plantillas que no se mandan", () => {
  const r = [
    whatsappReach({ phone: "+57 601 234 5678" }),
    whatsappReach({ phone: "+57 300 123 4567" }),
    whatsappReach({ phone: "+525512345678", learned: { status: "no_whatsapp" } }),
    whatsappReach({ phone: "+528001234567" }),
    whatsappReach({ phone: "" }),
  ];
  const s = reachSummary(r, 2);
  assertEquals([s.total, s.fixed, s.switchboard, s.probable, s.no_whatsapp, s.no_phone, s.avoided], [5, 1, 1, 1, 1, 1, 6]);
  assertEquals(reachSummary([], 3).avoided, 0);
});

// ── Espejos: js/phone-latam.js y js/phone-lines.js deben dar exactamente lo mismo ──

const PHONES = [
  "+5215512345678", "+525512345678", "5512345678", "5215512345678", "044 55 1234 5678", "(81) 8123-4567",
  "01 800 123 4567", "+528001234567", "+52 55 5000 1000 ext. 214", "+52 55 1234",
  "+54 9 11 4321 1234", "011 15 4321-1234", "+54 11 15 4321 1234", "0351 15 612 3456", "011 4321-1234",
  "+54 11 4321 1234", "0800 222 1234", "11 15 2345 6789",
  "+55 11 98765-4321", "(11) 3456-7890", "+55 21 8765 4321", "0 21 11 98765 4321", "0800 123 4567", "5133334444",
  "+57 310 123 4567", "+57 601 234 5678", "+57 1 234 5678", "01 8000 123456", "3001234567",
  "+56 9 8765 4321", "+56 2 2345 6789", "600 123 4567", "987 654 321", "(01) 234-5678", "099 123 4567",
  "+593 99 123 4567", "+598 94 123 456", "+595 981 123456", "+591 71234567", "+58 412 1234567",
  "+506 8312 3456", "+507 6123 4567", "+502 5123 4567", "+503 7123 4567", "+504 9123 4567", "+505 8123 4567",
  "+34 612 345 678", "+1 800 555 0100", "+1 809 555 0100", "+1 415 555 0100", "+999 1234 5678",
  "12345678", "123", "", "0057 300 123 4567", "55 1234 5678 x 12",
];
const COUNTRIES = [undefined, "Mexico", "México", "MX", "Argentina", "Brasil", "Brazil", "Colombia", "Chile", "Perú", "Ecuador", "República Dominicana", "Narnia"];
const TYPES = [undefined, "mobile", "work_hq", "work_direct", "home", "landline", "switchboard", "other"];

async function loadJs() {
  const g: Record<string, any> = {};
  for (const f of ["phone-latam.js", "phone-lines.js"]) {
    const src = await Deno.readTextFile(new URL(`../../../js/${f}`, import.meta.url));
    new Function("window", src)(g);
  }
  return g;
}

Deno.test("js/phone-latam.js es espejo exacto de _shared/phone-latam.ts", async () => {
  const js = (await loadJs()).PhoneLatam;
  for (const p of PHONES) for (const c of COUNTRIES) for (const t of TYPES) {
    const opts = { country: c, type: t };
    assertEquals(js.normalizePhone(p, opts), normalizePhone(p, opts), JSON.stringify([p, c, t]));
    assertEquals(js.whatsappCapable(js.normalizePhone(p, opts)), whatsappCapable(normalizePhone(p, opts)));
  }
  for (const c of COUNTRIES) assertEquals(js.countryIso(c), countryIso(c));
  for (const t of TYPES) assertEquals(js.providerPhoneType(t), providerPhoneType(t));
});

Deno.test("js/phone-lines.js es espejo exacto de _shared/phone-lines.ts", async () => {
  const js = (await loadJs()).PhoneLines;
  const learned = [null, { status: "no_whatsapp", code: "131026" }, { status: "no_whatsapp", code: "not_on_whatsapp" }, { status: "has_whatsapp" }];
  for (const p of PHONES) {
    assertEquals(js.reachKey(p), reachKey(p), p);
    for (const c of COUNTRIES) for (const t of TYPES) {
      assertEquals(js.lineType(p, c, t), lineType(p, c, t), JSON.stringify([p, c, t]));
      for (const l of learned) {
        const input = { phone: p, country: c, providerType: t ?? null, learned: l as any };
        assertEquals(js.whatsappReach(input), whatsappReach(input), JSON.stringify(input));
      }
    }
  }
  for (const d of ["(#131026) Message Undeliverable.", "not registered on WhatsApp", "#131037", "#1310260", "", "Invalid WhatsApp contact", "Message undeliverable."]) {
    assertEquals(js.noWhatsappCode(d), noWhatsappCode(d), d);
  }
  const snap = { phone_numbers: [{ sanitized_number: "+525511112222", type: "work_hq" }, { raw_number: "+52 1 55 3333 4444", type: "mobile" }] };
  for (const p of ["+52 55 1111 2222", "+525533334444", "+52"]) assertEquals(js.apolloPhoneType(snap, p), apolloPhoneType(snap, p));
  const rs = PHONES.map((p) => whatsappReach({ phone: p }));
  assertEquals(js.reachSummary(rs, 2), reachSummary(rs, 2));
  // memberReach (solo navegador) usa phone_type guardado antes que el snapshot.
  assertEquals(js.memberReach({ phone: "+525512345678", phone_type: "switchboard", snapshot: { phone_numbers: [{ sanitized_number: "+525512345678", type: "mobile" }] } }, new Map()).status, "switchboard");
  assertEquals(js.memberReach({ phone: "+525512345678", snapshot: { phone_numbers: [{ sanitized_number: "+525512345678", type: "mobile" }] } }, new Map()).status, "probable");
});
