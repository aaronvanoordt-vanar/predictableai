/**
 * Qué puede tocar un cliente cuando habla con Apollo por la key COMPARTIDA de
 * la plataforma (`auth.mode === "platform"`, sin su propio Apollo conectado).
 *
 * Esa key es UNA sola cuenta de Apollo para todos los clientes. Todo lo que se
 * guarda ahí lo ven los demás: (2026-09-23) cada «Agregar a lista» creaba el
 * contacto en esa cuenta con el nombre de la lista como etiqueta, y la
 * búsqueda de personas devolvía esos contactos como «Guardado» con el email
 * ya revelado — el cliente B veía gratis los leads y emails que había
 * guardado el cliente A.
 *
 * Reglas en modo platform:
 *  • POST /contacts no llega a Apollo: se responde `{ contact: null }` (200)
 *    y el lead se guarda solo en Predictable. El motor de campañas ya no
 *    envía email en este modo, así que el contacto de Apollo no hace falta.
 *  • /mixed_people/api_search no devuelve `contacts`: los guardados por otros
 *    se entregan como una persona más de la base de Apollo (id = person_id),
 *    sin email, teléfono, etiquetas ni nada que haya puesto quien los guardó.
 */

type Json = Record<string, unknown>;

export const PLATFORM_SKIPPED_CONTACT = { contact: null, skipped: "platform_account" } as const;

export function blockedInPlatformMode(endpoint: string): boolean {
  return endpoint === "/contacts";
}

function obfuscate(lastName: unknown): string | undefined {
  const s = typeof lastName === "string" ? lastName.trim() : "";
  return s ? s[0] + "***" : undefined;
}

// Un contacto de la cuenta compartida → una fila con la forma de `people` de
// la búsqueda, solo con lo que la búsqueda gratuita ya mostraría de cualquiera.
export function contactAsPerson(c: Json): Json | null {
  const personId = c?.person_id;
  if (personId == null || personId === "") return null;
  const orgName = typeof c.organization_name === "string" ? c.organization_name : undefined;
  return {
    id: personId,
    first_name: c.first_name ?? undefined,
    last_name_obfuscated: obfuscate(c.last_name),
    title: c.title ?? undefined,
    organization: orgName ? { name: orgName } : undefined,
  };
}

export function sanitizePlatformSearch(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const d = data as Json;
  const contacts = Array.isArray(d.contacts) ? d.contacts as Json[] : [];
  const people = Array.isArray(d.people) ? d.people as Json[] : [];
  const seen = new Set(people.map((p) => String(p?.id ?? "")));
  const fromContacts: Json[] = [];
  for (const c of contacts) {
    const p = contactAsPerson(c);
    if (!p || seen.has(String(p.id))) continue;
    seen.add(String(p.id));
    fromContacts.push(p);
  }
  return { ...d, contacts: [], people: [...fromContacts, ...people] };
}

/**
 * ¿Los `apollo_contact_id` ya guardados del usuario son de OTRA cuenta de
 * Apollo? Pasa al conectar su Apollo por primera vez (los creó la cuenta
 * compartida) o al cambiar a una cuenta distinta. Un id de contacto solo
 * existe en la cuenta que lo creó: usarlo con la nueva hace fallar el email
 * de campaña y la respuesta desde la Bandeja. Reconectar la MISMA cuenta
 * (mismo `apollo_user_id`) los conserva.
 */
export function contactIdsFromOtherAccount(prevConfig: unknown, newApolloUserId: unknown): boolean {
  const prevId = (prevConfig as Json | null | undefined)?.apollo_user_id;
  if (prevId == null || prevId === "" || newApolloUserId == null || newApolloUserId === "") return true;
  return String(prevId) !== String(newApolloUserId);
}
