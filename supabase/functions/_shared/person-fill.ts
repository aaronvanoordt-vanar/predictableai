/**
 * Qué columnas de prospect_list_members se completan con la persona que
 * devuelve Apollo al enriquecer (/people/match y /people/bulk_match).
 *
 * La búsqueda (/mixed_people/api_search) ya no trae LinkedIn, país ni
 * ciudad, y con la key compartida los «Guardado» llegan como personas sin
 * datos (_shared/apollo-platform.ts). Esos datos solo llegan al enriquecer,
 * y antes se guardaban únicamente en `snapshot`: la columna LinkedIn de
 * Listas salía vacía y el paso de LinkedIn de las campañas omitía al lead.
 *
 * Solo rellena huecos: nunca pisa un valor que ya tenga la fila (lo puede
 * haber escrito el usuario). Espejo en js/prospecting-data.js
 * (`profileFillPatch`); se cambian juntos.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

function str(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

/**
 * ¿El nombre guardado es solo una parte (o una versión ofuscada) del que
 * reveló Apollo? La búsqueda gratuita trae el nombre y el apellido ofuscado
 * ("Ga***z") o nada, y el Radar guardaba eso tal cual: la lista y la Bandeja
 * mostraban medio nombre y, como "solo rellena huecos", nunca se corregía.
 * Se corrige solo cuando lo guardado está vacío, ofuscado o es un prefijo de
 * palabras del nombre completo; un nombre distinto escrito por el usuario no
 * se toca.
 */
export function isPartialName(current: unknown, full: unknown): boolean {
  const c = str(current);
  const f = str(full);
  if (!f) return false;
  if (!c) return true;
  if (c.includes("*")) return true;
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/).filter(Boolean);
  const cw = norm(c);
  const fw = norm(f);
  return cw.length < fw.length && cw.every((w, i) => fw[i] === w);
}

export function profileFillPatch(row: Json, person: Json): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!person || typeof person !== "object") return patch;
  const org = person.organization || person.account || {};
  const fromPerson: Record<string, string | null> = {
    linkedin_url: str(person.linkedin_url),
    title: str(person.title),
    first_name: str(person.first_name),
    last_name: str(person.last_name),
    name: str(person.name) || str([person.first_name, person.last_name].filter(Boolean).join(" ")),
    country: str(person.country),
    city: str(person.city),
    state: str(person.state),
    company: str(org.name) || str(person.organization_name),
    company_domain: str(org.primary_domain) || str(org.domain),
  };
  for (const [k, v] of Object.entries(fromPerson)) {
    if (v && !str(row?.[k])) patch[k] = v;
  }
  // Nombre: si lo guardado es parcial u ofuscado, el revelado lo reemplaza
  // (los tres campos juntos para que no queden cruzados).
  const full = fromPerson.name;
  if (full && !str(person.last_name_obfuscated) && isPartialName(row?.name, full)) {
    patch.name = full;
    if (fromPerson.first_name) patch.first_name = fromPerson.first_name;
    if (fromPerson.last_name) patch.last_name = fromPerson.last_name;
  }
  return patch;
}

/** Empareja `matches` de /people/bulk_match con los ids pedidos (ver espejo JS). */
export function alignMatches(ids: string[], matches: Json): Json[] {
  const list: Json[] = Array.isArray(matches) ? matches : [];
  const byId = new Map<string, Json>();
  for (const m of list) if (m && m.id) byId.set(m.id, m);
  const positional = list.length === ids.length && list.every((m) => !m || !m.id);
  return ids.map((id, i) => byId.get(id) || (positional ? list[i] || null : null));
}
