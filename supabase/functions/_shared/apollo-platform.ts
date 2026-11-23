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

// Campos públicos de una empresa (los que /mixed_companies/search trae de
// cualquier organización de la base). Lo demás de una `account` guardada en la
// cuenta compartida (dueño, etapa, etiquetas, campos propios, teléfono que
// alguien cargó…) es de otro cliente y no sale.
const PUBLIC_ORG_FIELDS = [
  "id", "organization_id", "name", "website_url", "primary_domain", "domain", "linkedin_url",
  "logo_url", "industry", "industries", "estimated_num_employees", "founded_year",
  "city", "state", "country", "short_description", "keywords",
];

/**
 * /mixed_companies/search con la key compartida (2026-11-23: Buscar → Empresas
 * viene por defecto en toda cuenta). Apollo devuelve aparte las empresas
 * guardadas en la cuenta (`accounts`): esa cuenta es de todos, así que se
 * entregan como una organización más, solo con sus campos públicos y sin la
 * marca de «guardada».
 */
export function sanitizePlatformCompanies(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const d = data as Json;
  const accounts = Array.isArray(d.accounts) ? d.accounts as Json[] : [];
  const orgs = Array.isArray(d.organizations) ? d.organizations as Json[] : [];
  const key = (o: Json) => String(o?.organization_id ?? o?.id ?? "");
  const seen = new Set(orgs.map(key));
  const fromAccounts: Json[] = [];
  for (const a of accounts) {
    if (!a || typeof a !== "object") continue;
    const o: Json = {};
    for (const f of PUBLIC_ORG_FIELDS) if (a[f] !== undefined && a[f] !== null) o[f] = a[f];
    // El id de una account es el de la cuenta compartida: se usa el de la organización.
    if (a.organization_id != null) o.id = a.organization_id;
    else delete o.id;
    const k = key(o);
    if (!o.name || (k && seen.has(k))) continue;
    if (k) seen.add(k);
    fromAccounts.push(o);
  }
  return { ...d, accounts: [], organizations: [...fromAccounts, ...orgs] };
}

/**
 * Filtros de búsqueda que apuntan a lo guardado en UNA cuenta de Apollo
 * (sus listas, sus personas tipo, «guardadas por tu equipo», el dueño…).
 * Buscar → «Importar búsqueda de Apollo» reenvía tal cual los filtros del
 * enlace (js/apollo-search-url.js); con la key compartida esos filtros
 * leerían las listas de la cuenta común — de otro cliente —, así que se
 * quitan antes de llegar a Apollo. Con el Apollo propio pasan.
 */
const ACCOUNT_SCOPED_FILTER = /(label|search_list|persona|prospected_by|owner|account_stage|contact_stage)/;

export function stripAccountScopedFilters(body: Json): { body: Json; removed: string[] } {
  const out: Json = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(body ?? {})) {
    if (ACCOUNT_SCOPED_FILTER.test(k)) removed.push(k);
    else out[k] = v;
  }
  return { body: out, removed };
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
