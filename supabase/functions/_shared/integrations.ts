/**
 * _shared/integrations.ts — catálogo y traducciones de las integraciones
 * (2026-09-23): HubSpot, Salesforce, Amplemarket, Google Sheets, Google
 * Calendar, Notion y ClickUp.
 *
 * Solo funciones puras: qué credenciales necesita cada plataforma y cómo se
 * traduce un lead de Predictable (fila de prospect_list_members) o un reporte
 * del Meeting Coach al formato de cada API. La edge function `integrations`
 * hace el HTTP; esto lo cubre `integrations.test.ts`.
 *
 * Regla de producto: nunca se inventa un dato para satisfacer un campo
 * obligatorio del destino. Si Salesforce exige Company y el lead no la tiene,
 * el lead se omite con su motivo — no se crea "Empresa desconocida".
 *
 * `PROVIDERS` es espejo de `PROVIDERS` en js/integrations.js (id, nombre,
 * categoría): se cambian juntos.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export type ProviderId =
  | "hubspot"
  | "salesforce"
  | "amplemarket"
  | "google_sheets"
  | "google_calendar"
  | "notion"
  | "clickup";

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  category: "crm" | "engagement" | "productivity";
  /** Variables de entorno del app de OAuth de la plataforma ([] = no hay OAuth). */
  oauthEnv: [string, string] | [];
  /** Se puede conectar pegando un token (private app / API key / token personal). */
  tokenAllowed: boolean;
}

export const PROVIDERS: ProviderMeta[] = [
  { id: "hubspot", name: "HubSpot", category: "crm", oauthEnv: ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"], tokenAllowed: true },
  { id: "salesforce", name: "Salesforce", category: "crm", oauthEnv: ["SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET"], tokenAllowed: false },
  { id: "amplemarket", name: "Amplemarket", category: "engagement", oauthEnv: [], tokenAllowed: true },
  { id: "google_sheets", name: "Google Sheets", category: "productivity", oauthEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], tokenAllowed: false },
  { id: "google_calendar", name: "Google Calendar", category: "productivity", oauthEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], tokenAllowed: false },
  { id: "notion", name: "Notion", category: "productivity", oauthEnv: ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"], tokenAllowed: true },
  { id: "clickup", name: "ClickUp", category: "productivity", oauthEnv: ["CLICKUP_CLIENT_ID", "CLICKUP_CLIENT_SECRET"], tokenAllowed: true },
];

export function providerMeta(id: unknown): ProviderMeta | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

// ── Scopes ────────────────────────────────────────────────────────────────

export const HUBSPOT_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
];

// Salesforce: `api` para leer/crear Leads y `refresh_token` para no pedir
// permiso cada 2 horas.
export const SALESFORCE_SCOPES = ["api", "refresh_token"];

// drive.file = solo los archivos que Predictable crea (no ve el resto del
// Drive): alcanza para crear la hoja y reescribirla. Es un scope no sensible.
export const GOOGLE_SHEETS_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
];

// Lectura de eventos (reuniones próximas para el Meeting Coach) y creación
// del seguimiento acordado.
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

// ── Leads ─────────────────────────────────────────────────────────────────

export interface Lead {
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  title?: string | null;
  company?: string | null;
  company_domain?: string | null;
  linkedin_url?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

export interface Skipped {
  id?: string;
  name: string;
  reason: string;
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function clean(v: unknown, max = 255): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function validEmail(v: unknown): string {
  const e = clean(v).toLowerCase();
  return EMAIL_RE.test(e) ? e : "";
}

/** Nombre y apellido: los campos separados si existen, si no se parte `name`. */
export function splitName(l: Lead): { first: string; last: string } {
  let first = clean(l.first_name, 80);
  let last = clean(l.last_name, 80);
  if (!first && !last) {
    const parts = clean(l.name, 160).split(" ").filter(Boolean);
    if (parts.length === 1) first = parts[0];
    else if (parts.length > 1) {
      first = parts[0];
      last = parts.slice(1).join(" ");
    }
  }
  return { first, last };
}

export function displayName(l: Lead): string {
  const { first, last } = splitName(l);
  return [first, last].filter(Boolean).join(" ") || validEmail(l.email) || clean(l.linkedin_url) || "Sin nombre";
}

function domainUrl(d: unknown): string {
  const v = clean(d).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return v ? "https://" + v : "";
}

function dropEmpty(o: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v) out[k] = v;
  return out;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Deduplica por email (el primero gana) sin tocar los que no tienen email. */
function dedupeByEmail(leads: Lead[]): Lead[] {
  const seen = new Set<string>();
  return leads.filter((l) => {
    const e = validEmail(l.email);
    if (!e) return true;
    if (seen.has(e)) return false;
    seen.add(e);
    return true;
  });
}

// HubSpot: upsert por email (POST /crm/v3/objects/contacts/batch/upsert,
// idProperty = email). Sin email no hay llave para no duplicar → se omite.
export function hubspotContactInputs(leads: Lead[]): { inputs: Json[]; skipped: Skipped[] } {
  const inputs: Json[] = [];
  const skipped: Skipped[] = [];
  for (const l of dedupeByEmail(leads)) {
    const email = validEmail(l.email);
    if (!email) {
      skipped.push({ id: l.id, name: displayName(l), reason: "sin email" });
      continue;
    }
    const { first, last } = splitName(l);
    inputs.push({
      idProperty: "email",
      id: email,
      properties: dropEmpty({
        email,
        firstname: first,
        lastname: last,
        jobtitle: clean(l.title),
        company: clean(l.company),
        website: domainUrl(l.company_domain),
        phone: clean(l.phone, 40),
        city: clean(l.city, 80),
        state: clean(l.state, 80),
        country: clean(l.country, 80),
      }),
    });
  }
  return { inputs, skipped };
}

// Salesforce: Lead exige LastName y Company. Sin cualquiera de los dos se
// omite (nunca se rellena con un valor inventado).
export function salesforceLeadRecords(leads: Lead[], leadSource = "Predictable"): { records: Json[]; skipped: Skipped[] } {
  const records: Json[] = [];
  const skipped: Skipped[] = [];
  for (const l of dedupeByEmail(leads)) {
    const { first, last } = splitName(l);
    const company = clean(l.company) || clean(l.company_domain);
    const lastName = last || first;
    if (!lastName) {
      skipped.push({ id: l.id, name: displayName(l), reason: "sin nombre" });
      continue;
    }
    if (!company) {
      skipped.push({ id: l.id, name: displayName(l), reason: "sin empresa" });
      continue;
    }
    records.push({
      attributes: { type: "Lead" },
      ...dropEmpty({
        FirstName: last ? first.slice(0, 40) : "",
        LastName: lastName.slice(0, 80),
        Company: company,
        Title: clean(l.title, 128),
        Email: validEmail(l.email),
        Phone: clean(l.phone, 40),
        Website: domainUrl(l.company_domain),
        City: clean(l.city, 40),
        State: clean(l.state, 80),
        Country: clean(l.country, 80),
        LeadSource: clean(leadSource, 40),
      }),
    });
  }
  return { records, skipped };
}

// Amplemarket, a una secuencia: email o linkedin_url en la raíz; el resto va
// en `data` (nombres en minúscula con guion bajo, máx. 1024 caracteres).
export function amplemarketSequenceLeads(leads: Lead[]): { leads: Json[]; skipped: Skipped[] } {
  const out: Json[] = [];
  const skipped: Skipped[] = [];
  for (const l of dedupeByEmail(leads)) {
    const email = validEmail(l.email);
    const linkedin = clean(l.linkedin_url, 1024);
    if (!email && !linkedin) {
      skipped.push({ id: l.id, name: displayName(l), reason: "sin email ni LinkedIn" });
      continue;
    }
    const { first, last } = splitName(l);
    out.push({
      email: email || null,
      linkedin_url: linkedin || null,
      data: dropEmpty({
        first_name: first,
        last_name: last,
        company_name: clean(l.company, 1024),
        company_domain: clean(l.company_domain, 1024),
        title: clean(l.title, 1024),
      }),
    });
  }
  return { leads: out, skipped };
}

// Amplemarket, a una lista nueva (type email): solo leads con email.
export function amplemarketListLeads(leads: Lead[]): { leads: Json[]; skipped: Skipped[] } {
  const out: Json[] = [];
  const skipped: Skipped[] = [];
  for (const l of dedupeByEmail(leads)) {
    const email = validEmail(l.email);
    if (!email) {
      skipped.push({ id: l.id, name: displayName(l), reason: "sin email" });
      continue;
    }
    const { first, last } = splitName(l);
    const row: Json = { email };
    const title = clean(l.title);
    const company = clean(l.company);
    const domain = clean(l.company_domain);
    const phone = clean(l.phone, 40);
    if (title) row.title = title;
    if (company) row.company_name = company;
    if (domain) row.company_domain = domain;
    if (phone) row.phone_numbers = [phone];
    const context = dropEmpty({ first_name: first, last_name: last, linkedin_url: clean(l.linkedin_url) });
    if (Object.keys(context).length) row.context = context;
    out.push(row);
  }
  return { leads: out, skipped };
}

// Google Sheets / Notion: la misma tabla, sin omitir a nadie.
export const TABLE_HEADER = ["Nombre", "Cargo", "Empresa", "Dominio", "Email", "Teléfono", "LinkedIn", "Ciudad", "País"];

export function tableRows(leads: Lead[]): string[][] {
  return leads.map((l) => [
    displayName(l),
    clean(l.title),
    clean(l.company),
    clean(l.company_domain),
    validEmail(l.email),
    clean(l.phone, 40),
    clean(l.linkedin_url, 500),
    clean(l.city, 80),
    clean(l.country, 80),
  ]);
}

// ── Notion ────────────────────────────────────────────────────────────────

function rt(text: string): Json[] {
  const t = String(text ?? "").slice(0, 2000);
  return t ? [{ type: "text", text: { content: t } }] : [];
}

export function notionParagraph(text: string): Json {
  return { object: "block", type: "paragraph", paragraph: { rich_text: rt(text) } };
}

export function notionHeading(text: string): Json {
  return { object: "block", type: "heading_2", heading_2: { rich_text: rt(text) } };
}

export function notionBullet(text: string): Json {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(text) } };
}

/**
 * Tablas de Notion con la lista. La API acepta hasta 100 hijos por bloque,
 * así que cada tabla lleva el encabezado + 99 filas; una lista más larga se
 * parte en varias tablas seguidas.
 */
export function notionTableBlocks(leads: Lead[]): Json[] {
  const row = (cells: string[]) => ({
    object: "block",
    type: "table_row",
    table_row: { cells: cells.map((c) => rt(c)) },
  });
  return chunk(tableRows(leads), 99).map((rows) => ({
    object: "block",
    type: "table",
    table: {
      table_width: TABLE_HEADER.length,
      has_column_header: true,
      has_row_header: false,
      children: [row(TABLE_HEADER), ...rows.map(row)],
    },
  }));
}

/** El reporte del Meeting Coach como bloques de Notion (solo lo que existe). */
export function meetingReportBlocks(meeting: Json): Json[] {
  const r = meeting?.final_report ?? {};
  const blocks: Json[] = [];
  const meta = [
    meeting?.prospect_name ? "Lead: " + clean(meeting.prospect_name) : "",
    meeting?.started_at ? "Fecha: " + String(meeting.started_at).slice(0, 10) : "",
    Number.isFinite(Number(r.score_total)) && r.score_total !== null && r.score_total !== undefined
      ? "Puntaje: " + Number(r.score_total) + "/100"
      : "",
    r.temperatura_lead ? "Temperatura: " + clean(r.temperatura_lead) : "",
  ].filter(Boolean).join(" · ");
  if (meta) blocks.push(notionParagraph(meta));

  const resumen = Array.isArray(r.resumen_corto) ? r.resumen_corto.filter(Boolean) : [];
  if (resumen.length || r.resumen) {
    blocks.push(notionHeading("Resumen"));
    if (resumen.length) resumen.forEach((s: string) => blocks.push(notionBullet(String(s))));
    else blocks.push(notionParagraph(String(r.resumen)));
  }
  const sp = r.siguiente_paso ?? {};
  if (sp.accion) {
    blocks.push(notionHeading("Siguiente paso"));
    blocks.push(notionParagraph([sp.accion, sp.cuando ? "(" + sp.cuando + ")" : "", sp.por_que ? "— " + sp.por_que : ""].filter(Boolean).join(" ")));
  }
  if (r.codigo_reptil) {
    blocks.push(notionHeading("Qué mueve al lead"));
    blocks.push(notionParagraph(String(r.codigo_reptil)));
  }
  const objections = Array.isArray(r.objections) ? r.objections : [];
  if (objections.length) {
    blocks.push(notionHeading("Objeciones"));
    objections.slice(0, 20).forEach((o: Json) => {
      blocks.push(notionBullet([o?.objection, o?.result ? "[" + o.result + "]" : "", o?.suggested_response ? "→ " + o.suggested_response : ""].filter(Boolean).join(" ")));
    });
  }
  const steps = Array.isArray(r.next_steps) ? r.next_steps : [];
  if (steps.length) {
    blocks.push(notionHeading("Próximos pasos"));
    steps.slice(0, 20).forEach((s: Json) => blocks.push(notionBullet([s?.accion, s?.cuando ? "(" + s.cuando + ")" : "", s?.detalle ? "— " + s.detalle : ""].filter(Boolean).join(" "))));
  }
  const fb = r.feedback ?? {};
  if (fb.consejo_principal) {
    blocks.push(notionHeading("Consejo del coach"));
    blocks.push(notionParagraph(String(fb.consejo_principal)));
  }
  return blocks.slice(0, 100);
}

// ── ClickUp ───────────────────────────────────────────────────────────────

export function clickupTaskForLead(l: Lead, listName: string): Json {
  const name = displayName(l);
  const company = clean(l.company);
  const lines = [
    `Lead de la lista «${clean(listName, 120)}» en Predictable.`,
    "",
    clean(l.title) ? "Cargo: " + clean(l.title) : "",
    company ? "Empresa: " + company : "",
    validEmail(l.email) ? "Email: " + validEmail(l.email) : "",
    clean(l.phone, 40) ? "Teléfono: " + clean(l.phone, 40) : "",
    clean(l.linkedin_url, 500) ? "LinkedIn: " + clean(l.linkedin_url, 500) : "",
    [clean(l.city, 80), clean(l.country, 80)].filter(Boolean).join(", "),
  ].filter((x, i) => i < 2 || x);
  return {
    name: ("Contactar a " + name + (company ? " — " + company : "")).slice(0, 250),
    description: lines.join("\n").trim(),
    tags: ["predictable"],
  };
}

/** El siguiente paso de una reunión del coach como tarea (null si no hay). */
export function clickupTaskForMeeting(meeting: Json): Json | null {
  const r = meeting?.final_report ?? {};
  const sp = r.siguiente_paso ?? {};
  const accion = clean(sp.accion, 200);
  if (!accion) return null;
  const who = clean(meeting?.prospect_name, 120);
  const resumen = Array.isArray(r.resumen_corto) ? r.resumen_corto.filter(Boolean).join("\n") : clean(r.resumen, 1000);
  return {
    name: (accion + (who ? " — " + who : "")).slice(0, 250),
    description: [
      sp.cuando ? "Cuándo: " + clean(sp.cuando) : "",
      sp.por_que ? "Por qué: " + clean(sp.por_que, 500) : "",
      resumen ? "\nResumen de la reunión:\n" + resumen : "",
    ].filter(Boolean).join("\n"),
    tags: ["predictable", "meeting-coach"],
  };
}

// ── Google Calendar ───────────────────────────────────────────────────────

const MEETING_URL_RE = /https:\/\/(?:[a-z0-9-]+\.)?(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com)\/[^\s"'<>)]+/i;

/** El link de videollamada de un evento (Meet, Zoom, Teams, Webex) o "". */
export function meetingLinkOf(ev: Json): string {
  const hang = String(ev?.hangoutLink ?? "");
  if (/^https:\/\//.test(hang)) return hang;
  for (const ep of ev?.conferenceData?.entryPoints ?? []) {
    if (ep?.entryPointType === "video" && /^https:\/\//.test(String(ep?.uri ?? ""))) return String(ep.uri);
  }
  for (const field of [ev?.location, ev?.description]) {
    const m = String(field ?? "").match(MEETING_URL_RE);
    if (m) return m[0];
  }
  return "";
}

export interface CalendarItem {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  meeting_url: string;
  html_link: string;
  attendees: { email: string; name: string }[];
}

/** Evento de Google → lo que pinta la UI (sin el propio organizador en invitados). */
export function toCalendarItem(ev: Json, selfEmail = ""): CalendarItem {
  const me = String(selfEmail).toLowerCase();
  return {
    id: String(ev?.id ?? ""),
    title: clean(ev?.summary, 200) || "(Sin título)",
    start: String(ev?.start?.dateTime ?? ev?.start?.date ?? ""),
    end: String(ev?.end?.dateTime ?? ev?.end?.date ?? ""),
    all_day: !ev?.start?.dateTime,
    meeting_url: meetingLinkOf(ev),
    html_link: String(ev?.htmlLink ?? ""),
    attendees: (ev?.attendees ?? [])
      .filter((a: Json) => a?.email && !a?.self && String(a.email).toLowerCase() !== me && !a?.resource)
      .slice(0, 20)
      .map((a: Json) => ({ email: String(a.email), name: clean(a.displayName, 120) })),
  };
}

// ── Errores de API → texto para el usuario ────────────────────────────────

/** Mensaje corto y legible a partir del cuerpo de error de cualquiera de las APIs. */
export function apiErrorMessage(body: Json, status: number): string {
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  let msg = "";
  if (Array.isArray(body)) msg = pick(body[0]?.message) || pick(body[0]?.errorCode);
  else if (body && typeof body === "object") {
    msg = pick(body.message) || pick(body.error_description) || pick(body.err) ||
      pick(body.error?.message) || pick(body.error) || pick(body.errors?.[0]?.message) ||
      pick(body._errors?.[0]?.title) || pick(body.detail);
  } else msg = pick(body);
  return (msg || "Error " + status).slice(0, 300);
}
