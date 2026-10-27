import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseSharedContacts, sharedContactText } from "./shared-contact.ts";

Deno.test("Meta: contacts[] con nombre y teléfono", () => {
  const t = sharedContactText([{ name: { formatted_name: "Miguel Balderas" }, phones: [{ phone: "+52 55 1234 5678", wa_id: "525512345678" }] }]);
  assertEquals(t, "👤 Miguel Balderas · +525512345678");
});

Deno.test("WATI: vCard en data", () => {
  const v = "BEGIN:VCARD\nVERSION:3.0\nFN:Miguel Balderas\nTEL;type=CELL;waid=525512345678:+52 55 1234 5678\nEND:VCARD";
  assertEquals(parseSharedContacts(v), [{ name: "Miguel Balderas", phones: ["+525512345678"] }]);
});

Deno.test("WATI: JSON en string", () => {
  assertEquals(sharedContactText(JSON.stringify({ contacts: [{ name: "Ana", phones: ["5491122334455"] }] })), "👤 Ana · +5491122334455");
});

Deno.test("sin datos: etiqueta de siempre", () => {
  assertEquals(sharedContactText(null, "", {}), "👤 Contacto");
});
