// Tarjeta de contacto que el lead comparte por WhatsApp («te paso a mi
// compañero»): Meta la manda en `contacts[]` (name + phones) y WATI en `data`
// como vCard, JSON o texto. Se lee de forma tolerante porque WATI no documenta
// la forma exacta. Nunca inventa: sin nombre ni número devuelve "👤 Contacto".
// deno test: shared-contact.test.ts

type Json = Record<string, any>;

export interface SharedContact { name: string; phones: string[] }

const LABEL = "👤 Contacto";

function phoneOf(v: unknown): string {
  const s = String(v ?? "").trim();
  const d = s.replace(/\D/g, "");
  if (d.length < 7) return "";
  return s.startsWith("+") ? `+${d}` : d.length >= 10 ? `+${d}` : d;
}

function fromObject(c: Json): SharedContact | null {
  if (!c || typeof c !== "object") return null;
  const n = c.name;
  const name = String(
    (typeof n === "string" ? n : n?.formatted_name ?? [n?.first_name, n?.last_name].filter(Boolean).join(" ")) ||
      c.formatted_name || c.displayName || c.fullName || c.full_name || c.first_name || "",
  ).trim();
  const raw: unknown[] = [];
  for (const p of Array.isArray(c.phones) ? c.phones : []) raw.push(p?.wa_id ?? p?.phone ?? p?.number ?? p);
  for (const k of ["phone", "number", "wa_id", "waId", "tel"]) if (c[k]) raw.push(c[k]);
  const phones = [...new Set(raw.map(phoneOf).filter(Boolean))];
  return name || phones.length ? { name, phones } : null;
}

function fromVcard(text: string): SharedContact[] {
  const out: SharedContact[] = [];
  for (const card of text.split(/BEGIN:VCARD/i).slice(1)) {
    const fn = /^FN[^:\n]*:(.+)$/im.exec(card)?.[1]?.trim() ?? "";
    const n = /^N[^:\n]*:(.+)$/im.exec(card)?.[1]?.split(";").map((x) => x.trim()).filter(Boolean).reverse().join(" ") ?? "";
    const waid = [...card.matchAll(/waid=(\d+)/gi)].map((m) => m[1]);
    const tel = [...card.matchAll(/^[^\n]*TEL[^:\n]*:(.+)$/gim)].map((m) => m[1]);
    const phones = [...new Set([...waid, ...tel].map(phoneOf).filter(Boolean))];
    const name = fn || n;
    if (name || phones.length) out.push({ name, phones });
  }
  return out;
}

/** Contactos compartidos de un mensaje de Meta (`contacts[]`) o de WATI (`data`/`contacts`/`text`). */
export function parseSharedContacts(...sources: unknown[]): SharedContact[] {
  const out: SharedContact[] = [];
  const visit = (v: unknown, depth = 0): void => {
    if (v == null || depth > 3) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (typeof v === "string") {
      const s = v.trim();
      if (/BEGIN:VCARD/i.test(s)) { out.push(...fromVcard(s)); return; }
      if (s.startsWith("{") || s.startsWith("[")) { try { visit(JSON.parse(s), depth + 1); } catch { /* texto */ } }
      return;
    }
    if (typeof v === "object") {
      const o = v as Json;
      for (const k of ["contacts", "vcard", "vcards", "data", "contact"]) if (o[k] != null) { visit(o[k], depth + 1); return; }
      const c = fromObject(o);
      if (c) out.push(c);
    }
  };
  for (const s of sources) visit(s);
  const seen = new Set<string>();
  return out.filter((c) => { const k = `${c.name}|${c.phones.join(",")}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Texto de la burbuja: «👤 Miguel Balderas · +52 55 …»; sin datos, la etiqueta de siempre. */
export function sharedContactText(...sources: unknown[]): string {
  const list = parseSharedContacts(...sources);
  if (!list.length) return LABEL;
  return list.slice(0, 5).map((c) => `👤 ${[c.name, c.phones.join(" / ")].filter(Boolean).join(" · ")}`).join("\n");
}
