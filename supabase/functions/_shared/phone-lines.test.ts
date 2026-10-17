// deno test --allow-read _shared/phone-lines.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import {
  apolloPhoneType, countryOf, lineType, noWhatsappCode, reachKey, reachSummary, whatsappReach,
} from "./phone-lines.ts";

const kind = (phone: string, country?: string) => lineType(phone, country).kind;

Deno.test("México: el 52 1 delata un celular; 10 dígitos no dicen nada; 800 es de empresa", () => {
  assertEquals(kind("+5215512345678"), "mobile");
  assertEquals(kind("+525512345678"), "unknown");
  assertEquals(kind("5512345678", "Mexico"), "unknown");
  assertEquals(kind("+528001234567"), "fixed");
  assertEquals(lineType("+525512345678").country, "MX");
});

Deno.test("Colombia: 3 = celular, 60 = fijo (marcación única), formato viejo = fijo", () => {
  assertEquals(kind("+57 300 123 4567"), "mobile");
  assertEquals(kind("+57 601 234 5678"), "fixed");
  assertEquals(kind("+57 1 234 5678"), "fixed");
  assertEquals(kind("3001234567", "Colombia"), "mobile");
  assertEquals(kind("6012345678", "Colombia"), "fixed");
  assertEquals(kind("+57 1800 123 4567"), "unknown"); // no es un formato del plan
  assertEquals(kind("+57 01 800 1234567"), "fixed");
});

Deno.test("Chile: 9 = celular, 2–7 = fijo, 44 VoIP sin clasificar", () => {
  assertEquals(kind("+56 9 8765 4321"), "mobile");
  assertEquals(kind("+56 2 2421 3146"), "fixed");
  assertEquals(kind("+56 32 212 3456"), "fixed");
  assertEquals(kind("+56 44 123 4567"), "unknown");
  assertEquals(kind("987654321", "Chile"), "mobile");
});

Deno.test("Perú: 9 + 8 = celular; Lima 1 + 7 y provincias = fijo", () => {
  assertEquals(kind("+51 987 654 321"), "mobile");
  assertEquals(kind("+51 1 234 5678"), "fixed");
  assertEquals(kind("+51 54 123456"), "fixed");
  assertEquals(kind("01 234 5678", "Perú"), "fixed");
});

Deno.test("Argentina: 54 9 = celular; 54 + 10 no se sabe; 15 local = celular", () => {
  assertEquals(kind("+54 9 11 2345 6789"), "mobile");
  assertEquals(kind("+54 11 2345 6789"), "unknown");
  assertEquals(kind("11 15 2345 6789", "Argentina"), "mobile");
  assertEquals(kind("351 15 234 5678", "Argentina"), "mobile");
  assertEquals(kind("+54 800 123 4567"), "fixed");
});

Deno.test("Brasil: DDD + 9 = celular; DDD + 2–5 = fijo; 8 dígitos 6–9 = celular viejo", () => {
  assertEquals(kind("+55 11 98765 4321"), "mobile");
  assertEquals(kind("+55 11 3456 7890"), "fixed");
  assertEquals(kind("+55 21 8765 4321"), "mobile");
  assertEquals(kind("+55 0800 123 4567"), "fixed");
  // Fijo de Porto Alegre sin código de país: no es un número de Perú (+51).
  assertEquals(lineType("5133334444", "Brasil"), { country: "BR", kind: "fixed", reason: lineType("+55 51 3333 4444").reason });
});

Deno.test("país fuera de los seis o sin datos: se envía igual", () => {
  assertEquals(kind("+1 415 555 0100"), "unknown");
  assertEquals(kind("12345"), "unknown");
  assertEquals(countryOf("México"), "MX");
  assertEquals(countryOf("Spain"), null);
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

Deno.test("whatsappReach: lo aprendido manda, luego el plan, luego Apollo; ante la duda se envía", () => {
  const mxUnknown = "+525512345678";
  assertEquals(whatsappReach({ phone: "" }).status, "no_phone");
  assertEquals(whatsappReach({ phone: mxUnknown, learned: { status: "no_whatsapp", code: "131026" } }).send, false);
  assertEquals(whatsappReach({ phone: "+57 601 234 5678", learned: { status: "has_whatsapp" } }).status, "confirmed");
  assertEquals(whatsappReach({ phone: "+57 601 234 5678" }), {
    status: "fixed", label: "Fijo", send: false,
    reason: "Fijo de Colombia (60 + indicativo). Un fijo no recibe la plantilla.",
  });
  assertEquals(whatsappReach({ phone: "+57 300 123 4567", apolloType: "work_hq" }).status, "probable"); // el plan gana
  assertEquals(whatsappReach({ phone: mxUnknown, apolloType: "work_hq" }).send, false);
  assertEquals(whatsappReach({ phone: mxUnknown, apolloType: "mobile" }).status, "probable");
  assertEquals(whatsappReach({ phone: mxUnknown }), { status: "unknown", label: "Por confirmar", send: true, reason: lineType(mxUnknown).reason });
  assertEquals(whatsappReach({ phone: mxUnknown, learned: { status: "no_whatsapp", code: "not_on_whatsapp" } }).reason.includes("#"), false);
});

Deno.test("reachSummary cuenta y estima las plantillas que no se mandan", () => {
  const r = [
    whatsappReach({ phone: "+57 601 234 5678" }),
    whatsappReach({ phone: "+57 300 123 4567" }),
    whatsappReach({ phone: "+525512345678", learned: { status: "no_whatsapp" } }),
    whatsappReach({ phone: "" }),
  ];
  const s = reachSummary(r, 2);
  assertEquals([s.total, s.fixed, s.probable, s.no_whatsapp, s.no_phone, s.avoided], [4, 1, 1, 1, 1, 4]);
  assertEquals(reachSummary([], 3).avoided, 0);
});

// ── Espejo: js/phone-lines.js debe dar exactamente lo mismo ─────────────────

Deno.test("js/phone-lines.js es espejo exacto de _shared/phone-lines.ts", async () => {
  const src = await Deno.readTextFile(new URL("../../../js/phone-lines.js", import.meta.url));
  const g: Record<string, any> = {};
  new Function("window", src)(g);
  const js = g.PhoneLines;
  const phones = [
    "+5215512345678", "+525512345678", "5512345678", "+528001234567", "+57 300 123 4567", "+57 601 234 5678",
    "+57 1 234 5678", "3001234567", "+57 01 800 1234567", "+56 9 8765 4321", "+56 2 2421 3146", "+56 44 123 4567",
    "+51 987 654 321", "+51 1 234 5678", "01 234 5678", "+54 9 11 2345 6789", "+54 11 2345 6789", "11 15 2345 6789",
    "+54 800 123 4567", "+55 11 98765 4321", "+55 11 3456 7890", "+55 21 8765 4321", "+55 0800 123 4567",
    "5133334444", "+1 415 555 0100", "12345", "", "0057 300 123 4567",
  ];
  const countries = [undefined, "Mexico", "México", "Colombia", "Chile", "Perú", "Argentina", "Brasil", "Brazil", "Spain"];
  const learned = [null, { status: "no_whatsapp", code: "131026" }, { status: "no_whatsapp", code: "not_on_whatsapp" }, { status: "has_whatsapp" }];
  const types = [null, "mobile", "work_hq", "home"];
  for (const p of phones) {
    assertEquals(js.reachKey(p), reachKey(p), p);
    for (const c of countries) {
      assertEquals(js.lineType(p, c), lineType(p, c), `${p} ${c}`);
      for (const l of learned) for (const t of types) {
        const input = { phone: p, country: c, apolloType: t, learned: l as any };
        assertEquals(js.whatsappReach(input), whatsappReach(input), JSON.stringify(input));
      }
    }
  }
  for (const c of countries) assertEquals(js.countryOf(c), countryOf(c));
  for (const d of ["(#131026) Message Undeliverable.", "not registered on WhatsApp", "#131037", "#1310260", "", "Invalid WhatsApp contact", "Message undeliverable."]) {
    assertEquals(js.noWhatsappCode(d), noWhatsappCode(d), d);
  }
  const snap = { phone_numbers: [{ sanitized_number: "+525511112222", type: "work_hq" }, { raw_number: "+52 1 55 3333 4444", type: "mobile" }] };
  for (const p of ["+52 55 1111 2222", "+525533334444", "+52"]) assertEquals(js.apolloPhoneType(snap, p), apolloPhoneType(snap, p));
  const rs = phones.map((p) => whatsappReach({ phone: p }));
  assertEquals(js.reachSummary(rs, 2), reachSummary(rs, 2));
});
