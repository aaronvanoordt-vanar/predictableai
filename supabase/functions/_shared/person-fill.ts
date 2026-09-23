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
  return patch;
}
