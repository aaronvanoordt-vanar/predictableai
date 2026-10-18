// deno test --allow-read _shared/phone-latam.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { countryIso, normalizePhone, pickBestPhone, providerPhoneType, whatsappCapable } from "./phone-latam.ts";

function n(raw: string, country?: string, type?: string) {
  const r = normalizePhone(raw, { country, type });
  return r && { e164: r.e164, country: r.country, type: r.type, valid: r.valid, ext: r.extension };
}

Deno.test("México: +52 1 y 044/045 se quitan; el número solo no dice el tipo", () => {
  assertEquals(n("+52 1 55 1234 5678"), { e164: "+525512345678", country: "MX", type: "mobile", valid: true, ext: null });
  assertEquals(n("5215512345678", "Mexico"), { e164: "+525512345678", country: "MX", type: "mobile", valid: true, ext: null });
  assertEquals(n("044 55 1234 5678", "México"), { e164: "+525512345678", country: "MX", type: "mobile", valid: true, ext: null });
  assertEquals(n("+52 55 1234 5678")?.type, "unknown");
  assertEquals(n("+52 55 1234 5678", undefined, "mobile")?.type, "mobile");
  assertEquals(n("(81) 8123-4567", "MX"), { e164: "+528181234567", country: "MX", type: "unknown", valid: true, ext: null });
  assertEquals(n("01 800 123 4567", "MX")?.type, "switchboard");
});

Deno.test("Argentina: 15 → 9, nacional sin 15 = fijo, +54 sin 9 ambiguo", () => {
  assertEquals(n("+54 9 11 4321 1234"), { e164: "+5491143211234", country: "AR", type: "mobile", valid: true, ext: null });
  assertEquals(n("011 15 4321-1234", "Argentina"), { e164: "+5491143211234", country: "AR", type: "mobile", valid: true, ext: null });
  assertEquals(n("+54 11 15 4321 1234")?.e164, "+5491143211234");
  assertEquals(n("0351 15 612 3456", "AR")?.e164, "+5493516123456");
  assertEquals(n("011 4321-1234", "AR"), { e164: "+541143211234", country: "AR", type: "landline", valid: true, ext: null });
  assertEquals(n("+54 11 4321 1234")?.type, "unknown");
  assertEquals(n("+54 11 4321 1234", undefined, "mobile")?.e164, "+5491143211234");
  assertEquals(n("0800 222 1234", "AR")?.type, "switchboard");
});

Deno.test("Brasil: noveno dígito, fijo y 0800", () => {
  assertEquals(n("+55 11 98765-4321"), { e164: "+5511987654321", country: "BR", type: "mobile", valid: true, ext: null });
  assertEquals(n("(11) 3456-7890", "Brasil"), { e164: "+551134567890", country: "BR", type: "landline", valid: true, ext: null });
  assertEquals(n("+55 21 8765 4321")?.e164, "+5521987654321");
  assertEquals(n("0 21 11 98765 4321", "BR")?.e164, "+5511987654321");
  assertEquals(n("0800 123 4567", "BR")?.type, "switchboard");
});

Deno.test("Colombia, Chile, Perú, Ecuador", () => {
  assertEquals(n("+57 310 123 4567")?.type, "mobile");
  assertEquals(n("+57 601 234 5678")?.type, "landline");
  assertEquals(n("+57 1 234 5678")?.e164, "+576012345678");
  assertEquals(n("01 8000 123456", "Colombia")?.type, "switchboard");
  assertEquals(n("+56 9 8765 4321"), { e164: "+56987654321", country: "CL", type: "mobile", valid: true, ext: null });
  assertEquals(n("+56 2 2345 6789")?.type, "landline");
  assertEquals(n("600 123 4567", "Chile")?.type, "switchboard");
  assertEquals(n("987 654 321", "Perú"), { e164: "+51987654321", country: "PE", type: "mobile", valid: true, ext: null });
  assertEquals(n("(01) 234-5678", "Peru")?.e164, "+5112345678");
  assertEquals(n("099 123 4567", "Ecuador"), { e164: "+593991234567", country: "EC", type: "mobile", valid: true, ext: null });
});

Deno.test("extensión o número de la empresa = conmutador", () => {
  assertEquals(n("+52 55 5000 1000 ext. 214"), { e164: "+525550001000", country: "MX", type: "switchboard", valid: true, ext: "214" });
  assertEquals(n("+56 2 2345 6789", undefined, "work_hq")?.type, "switchboard");
  assertEquals(n("+1 800 555 0100")?.type, "switchboard");
  assertEquals(n("+1 809 555 0100")?.country, "DO");
});

Deno.test("lo que no calza no se inventa", () => {
  assertEquals(normalizePhone(""), null);
  assertEquals(normalizePhone("123"), null);
  assertEquals(n("+52 55 1234")?.valid, false);
  assertEquals(n("+999 1234 5678"), { e164: "+99912345678", country: null, type: "unknown", valid: true, ext: null });
  assertEquals(n("12345678")?.valid ?? false, false);
});

Deno.test("pickBestPhone prefiere el móvil; whatsappCapable", () => {
  const best = pickBestPhone([
    { number: "+52 55 5000 1000", type: "work_hq" },
    { number: "+52 1 55 1234 5678" },
    { number: "+52 55 2222 3333", type: "work_direct" },
  ]);
  assertEquals(best?.e164, "+525512345678");
  assertEquals(whatsappCapable(best), true);
  assertEquals(whatsappCapable(normalizePhone("+56 2 2345 6789")), false);
  assertEquals(pickBestPhone([]), null);
});

Deno.test("countryIso y providerPhoneType", () => {
  assertEquals(countryIso("México"), "MX");
  assertEquals(countryIso("Brazil"), "BR");
  assertEquals(countryIso("Narnia"), null);
  assertEquals(providerPhoneType("mobile"), "mobile");
  assertEquals(providerPhoneType("work_hq"), "switchboard");
  assertEquals(providerPhoneType("work_direct"), "landline");
  assertEquals(providerPhoneType(undefined), "unknown");
});
