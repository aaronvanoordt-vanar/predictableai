/**
 * Excluir de Buscar a quien ya está en una lista de Apollo (2026-10-08).
 *
 * «Importar desde Apollo» se eliminó el 2026-09-23 porque con la key
 * COMPARTIDA de la plataforma cada cliente veía las listas de todos. Esto es
 * otra cosa y más acotada: SOLO para las cuentas de Predictable de
 * `APOLLO_LISTS_USER_IDS` (pedido del dueño para una cuenta concreta) y SOLO
 * con su propio Apollo conectado (oauth / user_key, nunca `platform`), el
 * proxy deja leer:
 *  • GET /labels → solo las listas de contactos, con id, nombre y conteo;
 *  • POST /contacts/search → solo `contact_label_ids` + paginación, y la
 *    respuesta se recorta a `{ id, person_id }` por contacto: sirve para
 *    ocultar de la búsqueda, no para copiar los contactos a Predictable.
 *
 * Se usan ids de Supabase (no emails) para no publicar el correo de un
 * cliente en este repo, que se sirve en público.
 */

type Json = Record<string, unknown>;

// delnegrog@gmail.com
export const APOLLO_LISTS_USER_IDS = new Set<string>([
  "bbb3e4b7-b9e8-4a63-bea8-54d41ac0b2a1",
]);

export const APOLLO_LIST_ENDPOINTS = new Map<string, "GET" | "POST">([
  ["/labels", "GET"],
  ["/contacts/search", "POST"],
]);

export function apolloListsAllowed(userId: string, authMode: string): boolean {
  return APOLLO_LISTS_USER_IDS.has(userId) && authMode !== "platform";
}

const LABEL_ID = /^[a-f0-9]{24}$/;
export const MAX_LABELS_PER_SEARCH = 25;
export const MAX_PAGE = 500; // tope de Apollo: 100 × 500 = 50.000 contactos

/** Solo lo necesario para listar los contactos de unas listas. */
export function sanitizeContactsSearchBody(body: Json): Json | null {
  const raw = Array.isArray(body?.contact_label_ids) ? body.contact_label_ids : [];
  const ids = [...new Set(raw.filter((x): x is string => typeof x === "string" && LABEL_ID.test(x)))];
  if (!ids.length || ids.length > MAX_LABELS_PER_SEARCH) return null;
  const page = Math.trunc(Number(body.page));
  return {
    contact_label_ids: ids,
    page: page >= 1 && page <= MAX_PAGE ? page : 1,
    per_page: 100,
  };
}

/** Listas de contactos (no de cuentas ni de secuencias), sin nada más. */
export function sanitizeLabels(data: unknown): Json {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as Json | null)?.labels)
    ? (data as Json).labels as unknown[]
    : [];
  const labels = (arr as Json[])
    .filter((l) => l && typeof l.id === "string" && (l.modality == null || l.modality === "contacts"))
    .map((l) => ({
      id: String(l.id),
      name: typeof l.name === "string" && l.name.trim() ? l.name.trim() : "Lista sin nombre",
      count: Number.isFinite(Number(l.cached_count)) ? Number(l.cached_count) : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  return { labels };
}

/** Contactos de las listas → solo los ids que sirven para excluir. */
export function sanitizeContactsSearch(data: unknown): Json {
  const d = (data && typeof data === "object" ? data : {}) as Json;
  const contacts = (Array.isArray(d.contacts) ? d.contacts as Json[] : [])
    .map((c) => ({
      id: c?.id != null ? String(c.id) : null,
      person_id: c?.person_id != null && c.person_id !== "" ? String(c.person_id) : null,
    }))
    .filter((c) => c.id || c.person_id);
  const pg = (d.pagination && typeof d.pagination === "object" ? d.pagination : {}) as Json;
  return {
    contacts,
    pagination: {
      page: Number(pg.page) || 1,
      total_pages: Number(pg.total_pages) || 0,
      total_entries: Number(pg.total_entries) || 0,
    },
  };
}
