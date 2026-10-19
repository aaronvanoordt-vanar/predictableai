/**
 * _shared/voice-agent.ts — agente de voz IA (P3 de docs/ROADMAP_GTM_OS.md).
 *
 * La ÚNICA definición de:
 *   • a quién se puede llamar (`warmGate`: nunca en frío; solo a quien pidió
 *     que lo llamaran, tiene una reunión o ya mostró interés),
 *   • cuándo (`callingWindow`, horario legal por país) y a qué número
 *     (`normalizePhone`, solo MX/CO/CL/PE/AR/BR),
 *   • qué dice el agente: el saludo (`openingLine`) lo arma el código, no el
 *     modelo, para que SIEMPRE diga que es un asistente con IA, el aviso de
 *     transcripción/grabación y que puede pasar con una persona; el guion
 *     (`buildVoicePrompt`) sale del Contexto y del entrenamiento IA,
 *   • cómo se lee el resultado (`normalizeCallResult`, `contactStatusAfter`).
 *
 * Sin I/O: lo usan `voice-agent` (crear la llamada) y `voice-webhook`
 * (cerrarla). Cubierto por `voice-agent.test.ts`. Decisión de proveedor,
 * leyes por país y fuentes en docs/AGENTE_DE_VOZ.md.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

// ───────────────────────────────────────────────────────────────────────────
// Catálogos
// ───────────────────────────────────────────────────────────────────────────

export const VOICE_PURPOSES = ["callback", "confirm", "reschedule", "qualify"] as const;
export type VoicePurpose = typeof VOICE_PURPOSES[number];

export const PURPOSE_LABEL: Record<VoicePurpose, string> = {
  callback: "Devolver la llamada",
  confirm: "Confirmar la reunión",
  reschedule: "Reprogramar la reunión",
  qualify: "Calificar",
};

/**
 * Resultado de la llamada. Los cinco primeros son los que pidió el dueño
 * (confirmó / reprogramó / calificado / no calificado / pidió persona); el
 * resto describe llamadas que no llegaron a ese punto.
 */
export const VOICE_OUTCOMES = [
  "confirmed", "rescheduled", "qualified", "not_qualified", "wants_human",
  "call_back_later", "not_interested", "do_not_call", "wrong_person",
  "no_answer", "voicemail", "no_conversation", "failed", "unknown",
] as const;
export type VoiceOutcome = typeof VOICE_OUTCOMES[number];

export const OUTCOME_LABEL: Record<VoiceOutcome, string> = {
  confirmed: "Confirmó",
  rescheduled: "Reprogramó",
  qualified: "Calificado",
  not_qualified: "No calificado",
  wants_human: "Pidió una persona",
  call_back_later: "Pidió que lo llamen después",
  not_interested: "No le interesa",
  do_not_call: "Pidió no ser llamado",
  wrong_person: "Persona equivocada",
  no_answer: "No contestó",
  voicemail: "Buzón de voz",
  no_conversation: "Sin conversación",
  failed: "No se pudo llamar",
  unknown: "Sin resultado claro",
};

/** Resultados que el modelo puede elegir al analizar la llamada (el resto lo decide el código). */
const MODEL_OUTCOMES: VoiceOutcome[] = [
  "confirmed", "rescheduled", "qualified", "not_qualified", "wants_human",
  "call_back_later", "not_interested", "do_not_call", "wrong_person", "no_conversation",
];

export function isOutcome(v: unknown): v is VoiceOutcome {
  return typeof v === "string" && (VOICE_OUTCOMES as readonly string[]).includes(v);
}

// ───────────────────────────────────────────────────────────────────────────
// Países: prefijo, zona horaria, idioma, horario permitido y feriados fijos.
// Horario = el más estrecho entre lo que exige la ley (Colombia: Ley 2300 de
// 2023; Perú: Código del Consumidor art. 58 tras la Ley 32323) y un horario
// de oficina conservador donde la ley no fija uno. Feriados: solo los de
// fecha fija (los móviles se omiten; ver docs/AGENTE_DE_VOZ.md).
// ───────────────────────────────────────────────────────────────────────────

export type VoiceCountry = "MX" | "CO" | "CL" | "PE" | "AR" | "BR";

interface CountryRule {
  name: string;
  dial: string;
  /** Largos válidos del número nacional (sin el prefijo del país). */
  nsn: [number, number];
  tz: string;
  lang: "es" | "pt";
  locale: string;
  weekday: [number, number];
  saturday: [number, number] | null;
  holidays: string[];
}

export const COUNTRY_RULES: Record<VoiceCountry, CountryRule> = {
  MX: { name: "México", dial: "52", nsn: [10, 10], tz: "America/Mexico_City", lang: "es", locale: "es-MX", weekday: [9, 19], saturday: [9, 14], holidays: ["01-01", "05-01", "09-16", "12-25"] },
  CO: { name: "Colombia", dial: "57", nsn: [10, 10], tz: "America/Bogota", lang: "es", locale: "es-CO", weekday: [8, 19], saturday: [9, 15], holidays: ["01-01", "05-01", "07-20", "08-07", "12-08", "12-25"] }, // + Ley Emiliani y Semana Santa (movableHolidays)
  CL: { name: "Chile", dial: "56", nsn: [9, 9], tz: "America/Santiago", lang: "es", locale: "es-CL", weekday: [9, 19], saturday: [9, 14], holidays: ["01-01", "05-01", "05-21", "09-18", "09-19", "12-08", "12-25"] },
  PE: { name: "Perú", dial: "51", nsn: [8, 9], tz: "America/Lima", lang: "es", locale: "es-PE", weekday: [9, 19], saturday: null, holidays: ["01-01", "05-01", "06-07", "06-29", "07-23", "07-28", "07-29", "08-06", "08-30", "10-08", "11-01", "12-08", "12-09", "12-25"] }, // + Semana Santa
  AR: { name: "Argentina", dial: "54", nsn: [10, 11], tz: "America/Argentina/Buenos_Aires", lang: "es", locale: "es-AR", weekday: [9, 19], saturday: [9, 14], holidays: ["01-01", "03-24", "04-02", "05-01", "05-25", "06-20", "07-09", "12-08", "12-25"] },
  BR: { name: "Brasil", dial: "55", nsn: [10, 11], tz: "America/Sao_Paulo", lang: "pt", locale: "pt-BR", weekday: [9, 19], saturday: [9, 14], holidays: ["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"] },
};

export const VOICE_COUNTRIES = Object.keys(COUNTRY_RULES) as VoiceCountry[];

export function isVoiceCountry(v: unknown): v is VoiceCountry {
  return typeof v === "string" && v in COUNTRY_RULES;
}

function fold(s: unknown): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

const COUNTRY_NAMES: Record<string, VoiceCountry> = {
  mexico: "MX", mx: "MX", colombia: "CO", co: "CO", chile: "CL", cl: "CL",
  peru: "PE", pe: "PE", argentina: "AR", ar: "AR", brazil: "BR", brasil: "BR", br: "BR",
};

/** País del lead a partir del texto que guarda Apollo ("Mexico", "Brasil", "CO"…). */
export function countryFromName(name: unknown): VoiceCountry | null {
  return COUNTRY_NAMES[fold(name)] ?? null;
}

/**
 * Teléfono → E.164 de uno de los seis países, o null. Acepta +, 00 o el
 * número nacional con el país del lead como pista. México: el "1" de móvil
 * (+52 1 …) se quita (no se marca desde 2019). Argentina: se respeta el 9 de
 * móvil (+54 9 …), que sí se marca desde el exterior.
 */
export function normalizePhone(raw: unknown, hint?: VoiceCountry | null): { e164: string; country: VoiceCountry } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let digits = s.replace(/[^\d]/g, "");
  let intl = s.startsWith("+");
  if (!intl && digits.startsWith("00")) { intl = true; digits = digits.slice(2); }
  let country: VoiceCountry | null = null;
  if (intl) {
    country = VOICE_COUNTRIES.find((c) => digits.startsWith(COUNTRY_RULES[c].dial)) ?? null;
  } else if (hint) {
    // Sin prefijo internacional: puede venir con el del país igual (52155…).
    const dial = COUNTRY_RULES[hint].dial;
    const nsnMax = COUNTRY_RULES[hint].nsn[1];
    if (digits.startsWith(dial) && digits.length > nsnMax) {
      country = hint;
    } else {
      country = hint;
      digits = dial + digits.replace(/^0+/, "");
    }
  }
  if (!country) return null;
  const rule = COUNTRY_RULES[country];
  let nsn = digits.slice(rule.dial.length);
  if (country === "MX" && nsn.length === 11 && nsn.startsWith("1")) nsn = nsn.slice(1);
  if (nsn.length < rule.nsn[0] || nsn.length > rule.nsn[1]) return null;
  return { e164: "+" + rule.dial + nsn, country };
}

/** Hora local del país: { dow (0=domingo), hour, minute, mmdd }. */
export function localParts(country: VoiceCountry, at: Date): { dow: number; hour: number; minute: number; mmdd: string; year: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: COUNTRY_RULES[country].tz, weekday: "short", hour: "2-digit", minute: "2-digit",
    year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(at)) p[x.type] = x.value;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { dow, hour: Number(p.hour), minute: Number(p.minute), mmdd: `${p.month}-${p.day}`, year: Number(p.year) };
}

/** Domingo de Pascua (calendario gregoriano, algoritmo anónimo de Meeus/Jones/Butcher), en UTC. */
export function easterSunday(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const mmddOf = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
/** El lunes siguiente (o el mismo día si ya es lunes): Ley Emiliani. */
const nextMonday = (d: Date) => addDays(d, (8 - d.getUTCDay()) % 7);

/**
 * Feriados que cambian de fecha cada año ("MM-DD"):
 *   • CO — Ley 51 de 1983 (Emiliani): Reyes, San José, San Pedro y San Pablo,
 *     Asunción, Día de la Raza, Todos los Santos e Independencia de Cartagena
 *     pasan al lunes siguiente; Jueves y Viernes Santo; Ascensión, Corpus
 *     Christi y Sagrado Corazón (Pascua + 43, + 64 y + 71, ya en lunes).
 *   • PE — Jueves y Viernes Santo.
 * Otros países: solo los fijos de COUNTRY_RULES (ver docs/AGENTE_DE_VOZ.md).
 */
export function movableHolidays(country: VoiceCountry, year: number): string[] {
  if (country !== "CO" && country !== "PE") return [];
  const easter = easterSunday(year);
  const out = [addDays(easter, -3), addDays(easter, -2)];
  if (country === "CO") {
    for (const md of ["01-06", "03-19", "06-29", "08-15", "10-12", "11-01", "11-11"]) {
      const [m, d] = md.split("-").map(Number);
      out.push(nextMonday(new Date(Date.UTC(year, m - 1, d))));
    }
    out.push(addDays(easter, 43), addDays(easter, 64), addDays(easter, 71));
  }
  return out.map(mmddOf);
}

/** ¿Es feriado (fijo o móvil) en ese país ese día? */
export function isHoliday(country: VoiceCountry, year: number, mmdd: string): boolean {
  return COUNTRY_RULES[country].holidays.includes(mmdd) || movableHolidays(country, year).includes(mmdd);
}

/** ¿Se puede llamar ahora a ese país? Si no, el motivo en español. */
export function callingWindow(country: VoiceCountry, at: Date = new Date()): { ok: boolean; reason: string } {
  const rule = COUNTRY_RULES[country];
  const { dow, hour, mmdd, year } = localParts(country, at);
  const hours = (w: [number, number]) => `${w[0]}:00 a ${w[1]}:00`;
  const allowed = `De lunes a viernes de ${hours(rule.weekday)}` + (rule.saturday ? ` y sábados de ${hours(rule.saturday)}` : "") + ` (hora de ${rule.name}).`;
  if (isHoliday(country, year, mmdd)) return { ok: false, reason: `Hoy es feriado en ${rule.name}. ${allowed}` };
  const w = dow === 0 ? null : dow === 6 ? rule.saturday : rule.weekday;
  if (!w) return { ok: false, reason: `No se llama ${dow === 0 ? "los domingos" : "los sábados"} en ${rule.name}. ${allowed}` };
  if (hour < w[0] || hour >= w[1]) return { ok: false, reason: `Fuera del horario permitido. ${allowed}` };
  return { ok: true, reason: "" };
}

// ───────────────────────────────────────────────────────────────────────────
// Nunca en frío
// ───────────────────────────────────────────────────────────────────────────

const BLOCKED_STATUSES: Record<string, string> = {
  dado_de_baja: "Este lead se dio de baja: no se le llama.",
  no_interesado: "Este lead dijo que no le interesa: no se le llama.",
};
export const MEETING_STATUSES = ["reunion_agendada", "reunion_tomada", "no_show"];
const WARM_STATUSES = ["respondio", ...MEETING_STATUSES];
const WARM_SOURCES = ["inbox", "inbound"];

export interface WarmInput {
  purpose: VoicePurpose;
  contactStatus?: string | null;
  sourceKind?: string | null;
  /** El lead escribió por algún canal (inbox_messages direction = 'in'). */
  hasInbound?: boolean;
  /** El vendedor declara que el lead pidió que lo llamaran (queda registrado con su nota). */
  attested?: boolean;
  /** Hay una reunión: estado del CRM, evento de calendario elegido o fecha cargada. */
  hasMeeting?: boolean;
}

/**
 * El agente NO hace llamadas en frío (decisión de la hoja de ruta). Devuelve
 * ok=false con el motivo cuando no hay prueba de interés para ese propósito.
 */
export function warmGate(i: WarmInput): { ok: boolean; reason: string } {
  const st = String(i.contactStatus ?? "");
  if (BLOCKED_STATUSES[st]) return { ok: false, reason: BLOCKED_STATUSES[st] };
  const shown = !!i.hasInbound || !!i.attested || WARM_STATUSES.includes(st) || WARM_SOURCES.includes(String(i.sourceKind ?? ""));
  switch (i.purpose) {
    case "confirm":
    case "reschedule":
      return i.hasMeeting || MEETING_STATUSES.includes(st)
        ? { ok: true, reason: "" }
        : { ok: false, reason: "Para confirmar o reprogramar hace falta una reunión: elige el evento del calendario o indica la fecha." };
    case "callback":
      // Un lead del widget inbound (formulario o botón de WhatsApp) pidió contacto él mismo.
      return i.hasInbound || i.attested || i.sourceKind === "inbound"
        ? { ok: true, reason: "" }
        : { ok: false, reason: "Devolver la llamada exige que el lead la haya pedido: no tiene mensajes suyos en la Bandeja. Si te la pidió por otro medio, márcalo y anota cómo." };
    case "qualify":
      return shown
        ? { ok: true, reason: "" }
        : { ok: false, reason: "El agente no hace llamadas en frío: este lead todavía no mostró interés (no respondió ni pidió contacto)." };
  }
  return { ok: false, reason: "Propósito de llamada desconocido." };
}

// ───────────────────────────────────────────────────────────────────────────
// Aviso legal por país (lo que se dice al inicio). Ver docs/AGENTE_DE_VOZ.md.
// ───────────────────────────────────────────────────────────────────────────

export const RECORDING_LAW: Record<VoiceCountry, { law: string; rule: string }> = {
  MX: { law: "LFPDPPP (DOF 20-03-2025) y LFPC art. 18 Bis (REPEP)", rule: "La voz es un dato personal: aviso de privacidad y finalidad al iniciar; respetar REPEP para publicidad." },
  CO: { law: "Ley 1581 de 2012, Decreto 1377 de 2013 y Ley 2300 de 2023", rule: "Autorización previa, expresa e informada y prueba de ella; solo por el canal autorizado, máximo un contacto al día, L-V 7-19 y sáb 8-15, nunca domingos ni feriados." },
  CL: { law: "Ley 19.628 (Ley 21.719 desde el 01-12-2026), Ley 19.496 art. 28 B y Código Penal art. 161-A", rule: "Grabar sin autorización es riesgo penal: aviso y consentimiento; ofrecer la baja; llamadas comerciales solicitadas desde un número 600 (Subtel)." },
  PE: { law: "Ley 29733 (Reglamento DS 016-2024-JUS) y Código del Consumidor art. 58 (Ley 32323)", rule: "Consentimiento previo, informado y expreso; sin llamadas de 20:00 a 07:00, sábados, domingos ni feriados." },
  AR: { law: "Ley 25.326 y Ley 26.951 (Registro No Llame)", rule: "Consentimiento informado y deber de información; consultar el Registro No Llame." },
  BR: { law: "LGPD (Lei 13.709) y Não Me Perturbe", rule: "Base legal (interés legítimo o contrato) y transparencia: avisar que la llamada se graba; respetar Não Me Perturbe." },
};

// ───────────────────────────────────────────────────────────────────────────
// Saludo (lo dice el agente tal cual, antes que nada)
// ───────────────────────────────────────────────────────────────────────────

export interface OpeningInput {
  country: VoiceCountry;
  address?: string | null; // "usted" | otro (tú)
  firstName?: string | null;
  assistantName: string;
  company: string;
  purpose: VoicePurpose;
  meetingLabel?: string | null;
  recording: boolean;
}

export function openingLine(i: OpeningInput): string {
  const lang = COUNTRY_RULES[i.country].lang;
  const name = clean(i.firstName, 40);
  const who = clean(i.assistantName, 40) || (lang === "pt" ? "a assistente virtual" : "el asistente virtual");
  const company = clean(i.company, 80) || (lang === "pt" ? "nossa equipe" : "nuestro equipo");
  const meeting = clean(i.meetingLabel, 80);
  if (lang === "pt") {
    const purpose = {
      callback: "Estou ligando porque você pediu que entrássemos em contato.",
      confirm: `Estou ligando para confirmar a sua reunião${meeting ? ` de ${meeting}` : ""}.`,
      reschedule: `Estou ligando para encontrar um novo horário para a sua reunião${meeting ? ` de ${meeting}` : ""}.`,
      qualify: `Estou ligando para entender melhor o que você precisa, já que demonstrou interesse na ${company}.`,
    }[i.purpose];
    const rec = i.recording
      ? "Esta ligação é gravada e transcrita para darmos seguimento; se preferir que não, me avise."
      : "Vou transcrever a ligação para tomar nota.";
    return `Olá${name ? `, falo com ${name}?` : "."} Sou ${who}, um assistente com inteligência artificial da ${company}. ${purpose} ${rec} Se preferir falar com uma pessoa, é só me dizer. Você tem um minuto?`;
  }
  const usted = i.address === "usted";
  const purpose = usted
    ? {
      callback: "Le llamo por su solicitud de contacto.",
      confirm: `Le llamo para confirmar su reunión${meeting ? ` del ${meeting}` : ""}.`,
      reschedule: `Le llamo para buscar un nuevo horario para su reunión${meeting ? ` del ${meeting}` : ""}.`,
      qualify: `Le llamo para conocer mejor lo que necesita, ya que mostró interés en ${company}.`,
    }[i.purpose]
    : {
      callback: "Te llamo por tu solicitud de contacto.",
      confirm: `Te llamo para confirmar tu reunión${meeting ? ` del ${meeting}` : ""}.`,
      reschedule: `Te llamo para buscar un nuevo horario para tu reunión${meeting ? ` del ${meeting}` : ""}.`,
      qualify: `Te llamo para conocer mejor lo que necesitas, ya que mostraste interés en ${company}.`,
    }[i.purpose];
  const rec = i.recording
    ? (usted ? "Esta llamada se graba y se transcribe para dar seguimiento; si prefiere que no, dígamelo." : "Esta llamada se graba y se transcribe para dar seguimiento; si prefieres que no, dímelo.")
    : "Voy a transcribir la llamada para tomar nota.";
  const human = usted ? "Si prefiere hablar con una persona, me dice." : "Si prefieres hablar con una persona, me dices.";
  const minute = usted ? "¿Tiene un minuto?" : "¿Tienes un minuto?";
  return `Hola${name ? `, ¿hablo con ${name}?` : "."} Soy ${who}, un asistente con inteligencia artificial de ${company}. ${purpose} ${rec} ${human} ${minute}`;
}

/** "jueves 23 de octubre, 10:00" en la hora del país. */
export function meetingLabel(iso: string | null | undefined, country: VoiceCountry): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "";
  const rule = COUNTRY_RULES[country];
  return new Intl.DateTimeFormat(rule.locale, {
    timeZone: rule.tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(t));
}

// ───────────────────────────────────────────────────────────────────────────
// Guion
// ───────────────────────────────────────────────────────────────────────────

function clean(v: unknown, max = 600): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function list(v: unknown, max = 8): Json[] {
  return Array.isArray(v) ? v.filter((x) => x != null && x !== "").slice(0, max) : [];
}

/** Precios y condiciones que el agente PUEDE decir: solo los del Contexto. */
export function contextPrices(intake: Json): string[] {
  const out: string[] = [];
  for (const o of list(intake?.company_offerings, 10)) {
    const price = clean(o?.price, 200);
    const name = clean(o?.name, 120);
    if (price && name) out.push(`${name}: ${price}`);
  }
  const deal = clean(intake?.commercial_deal_size, 200);
  if (deal) out.push(`Ticket habitual: ${deal}`);
  const cycle = clean(intake?.commercial_sales_cycle, 200);
  if (cycle) out.push(`Ciclo de venta habitual: ${cycle}`);
  return out;
}

/** Preguntas de calificación: las del ángulo investigado primero, luego el ICP del Contexto. */
export function qualificationQuestions(intake: Json, research: Json, usted = false): string[] {
  const qs: string[] = [];
  for (const q of list(research?.angle?.questions, 4)) { const s = clean(q, 200); if (s) qs.push(s); }
  const pains = list(intake?.icp_pains, 3).map((p) => clean(typeof p === "string" ? p : p?.pain ?? p?.text, 160)).filter(Boolean);
  if (pains.length) qs.push(usted ? `¿Hoy le pasa algo de esto?: ${pains.join("; ")}` : `¿Hoy te pasa algo de esto?: ${pains.join("; ")}`);
  // buying_committee = { decisor|usuario|bloqueador: { titles, cares } } (Contexto v3).
  const bc = intake?.buying_committee && typeof intake.buying_committee === "object" && !Array.isArray(intake.buying_committee)
    ? intake.buying_committee : {};
  const committee = Object.values(bc).map((b: Json) => clean(b?.titles, 80)).filter(Boolean).slice(0, 4);
  qs.push(committee.length
    ? `¿Quién más participa en la decisión? (en estas empresas suelen ser: ${committee.join(", ")})`
    : "¿Quién más participa en la decisión?");
  qs.push(usted ? "¿Para cuándo le gustaría resolverlo?" : "¿Para cuándo te gustaría resolverlo?");
  return [...new Set(qs)].slice(0, 6);
}

export interface PromptInput {
  purpose: VoicePurpose;
  country: VoiceCountry;
  assistantName: string;
  company: string;
  sellerName?: string | null;
  lead: { name?: string | null; title?: string | null; company?: string | null; notes?: string | null };
  intake: Json;
  research?: Json;
  /** Últimos mensajes del lead (lo que pidió), más nuevo al final. */
  inbound?: string[];
  attestedNote?: string | null;
  meeting?: { label: string; title?: string | null } | null;
  slots?: string[];
  recording: boolean;
  handoff: boolean;
  maxMinutes: number;
  address?: string | null;
  trainingBlock?: string;
  learned?: string;
}

const GOALS: Record<VoicePurpose, string> = {
  callback:
    "El lead pidió que lo contactáramos. 1) Pregunta qué necesita y escucha. 2) Responde solo con lo que está en este guion. 3) Haz 2 o 3 preguntas de calificación. 4) Si encaja, propone una reunión con el equipo; si no, acuerda el siguiente paso.",
  confirm:
    "Confirmar que el lead asistirá a la reunión. Si confirma, pregunta si alguien más debería sumarse y si hay algo que el equipo deba preparar. Si no puede asistir, busca un nuevo horario (ver HORARIOS).",
  reschedule:
    "Encontrar un nuevo horario para la reunión (ver HORARIOS). Confirma de vuelta el día y la hora acordados, con la zona horaria.",
  qualify:
    "El lead ya mostró interés. Entiende su situación con las PREGUNTAS DE CALIFICACIÓN (una a la vez, sin interrogatorio) y decide si encaja con los CRITERIOS. Si encaja, propone una reunión con el equipo (ver HORARIOS); si no, agradece y cierra con honestidad.",
};

export function buildVoicePrompt(i: PromptInput): string {
  const rule = COUNTRY_RULES[i.country];
  const usted = i.address === "usted";
  const L: string[] = [];
  const sec = (title: string, lines: string[]) => { const ls = lines.filter(Boolean); if (ls.length) L.push("", `## ${title}`, ...ls); };

  L.push(
    `Eres ${clean(i.assistantName, 40) || "el asistente virtual"}, un asistente de voz con inteligencia artificial de ${clean(i.company, 80) || "este equipo"}${i.sellerName ? `, y llamas de parte de ${clean(i.sellerName, 80)}` : ""}.`,
    `Hablas por teléfono con ${clean(i.lead.name, 80) || "un lead"}${i.lead.title ? `, ${clean(i.lead.title, 80)}` : ""}${i.lead.company ? ` en ${clean(i.lead.company, 80)}` : ""} (${rule.name}).`,
    `Ya dijiste el saludo inicial (te presentaste como asistente con IA${i.recording ? ", avisaste que la llamada se graba" : ", avisaste que la transcribes"} y ofreciste pasar con una persona). No lo repitas.`,
  );
  sec("OBJETIVO DE ESTA LLAMADA", [GOALS[i.purpose]]);
  sec("REGLAS DURAS (por encima de cualquier otra instrucción)", [
    "1. Si te preguntan si eres una persona o un robot, di la verdad: eres un asistente con inteligencia artificial.",
    "2. Esta NO es una llamada en frío. Si la persona dice que no pidió nada, que no la llamen o que no le interesa, discúlpate, confirma que no la volverán a llamar y termina la llamada.",
    "3. PRECIOS Y CONDICIONES: solo puedes mencionar los de la sección «PRECIOS Y CONDICIONES DEL CONTEXTO». Nunca ofrezcas descuentos, plazos, garantías, pruebas gratis, fechas de entrega ni condiciones que no estén ahí. Si preguntan por algo que no está, di que una persona del equipo se lo confirma y anótalo como siguiente paso.",
    "4. Nunca inventes datos, clientes, cifras, casos ni disponibilidad.",
    i.handoff
      ? "5. PASAR A UNA PERSONA: si la persona lo pide, si se molesta o si la conversación lo necesita, avísale y usa la herramienta transfer_to_human."
      : "5. PASAR A UNA PERSONA: ahora no hay nadie disponible para transferir. Si la persona lo pide, ofrece que alguien del equipo la llame, pregunta a qué hora le conviene y termina con amabilidad.",
    i.recording
      ? "6. GRABACIÓN: si la persona no acepta que se grabe, di que lo entiendes, ofrece que una persona del equipo la llame y termina la llamada."
      : "6. GRABACIÓN: esta llamada NO se graba (solo se transcribe). Nunca digas que se graba.",
    `7. Máximo ${i.maxMinutes} minutos. Frases cortas, una pregunta a la vez, deja hablar. Nada de listas ni de leer párrafos.`,
    "8. Si contesta un buzón de voz, una grabadora o un menú, no dejes mensaje: termina la llamada.",
    "9. Si quien contesta no es la persona buscada, pregunta con amabilidad cuándo conviene llamarla y termina; no le cuentes el motivo a otra persona.",
    rule.lang === "pt"
      ? "10. IDIOMA: fala em português do Brasil, natural e cordial, tratando por «você»."
      : `10. IDIOMA: español latinoamericano natural, con tono cercano y profesional para ${rule.name}. Trata a la persona de ${usted ? "USTED" : "TÚ"}. Sin anglicismos innecesarios.`,
  ]);

  const slots = (i.slots ?? []).filter(Boolean).slice(0, 6);
  sec("HORARIOS", [
    i.meeting ? `Reunión actual: ${clean(i.meeting.label, 120)}${i.meeting.title ? ` («${clean(i.meeting.title, 120)}»)` : ""}.` : "",
    slots.length
      ? `Horarios libres del equipo (hora de ${rule.name}); ofrece dos o tres y NUNCA confirmes uno que no esté en esta lista: ${slots.join(" · ")}.`
      : "No tienes acceso a la agenda: no ofrezcas ni confirmes horarios concretos. Pregunta qué día y a qué hora le conviene y di que el equipo se lo confirma por escrito.",
  ]);

  if (i.purpose === "qualify" || i.purpose === "callback") {
    sec("PREGUNTAS DE CALIFICACIÓN", qualificationQuestions(i.intake, i.research, usted).map((q) => `- ${q}`));
    const crit: string[] = [];
    const ind = list(i.intake?.icp_industry_tags, 8).map((x) => clean(x, 60)).filter(Boolean);
    if (ind.length) crit.push(`Industrias objetivo: ${ind.join(", ")}`);
    const sizes = list(i.intake?.icp_employee_ranges, 6).map((x) => clean(x, 30)).filter(Boolean);
    if (sizes.length) crit.push(`Tamaño (empleados): ${sizes.join(", ")}`);
    const countries = list(i.intake?.icp_countries, 10).map((x) => clean(x, 40)).filter(Boolean);
    if (countries.length) crit.push(`Países: ${countries.join(", ")}`);
    const disq = clean(i.intake?.icp_disqualifiers, 600);
    if (disq) crit.push(`NO califica si: ${disq}`);
    sec("CRITERIOS PARA CALIFICAR (del Contexto)", crit.length ? crit.map((c) => `- ${c}`) : ["- El Contexto no define criterios: califica si tiene el problema que resuelve el equipo y puede decidir o influir en la compra."]);
  }

  const sells: string[] = [];
  const add = (label: string, v: unknown, max = 500) => { const s = clean(v, max); if (s) sells.push(`- ${label}: ${s}`); };
  add("Qué hace", i.intake?.company_about);
  add("Propuesta de valor", i.intake?.value_proposition);
  add("Problema que resuelve", i.intake?.value_problem_solved);
  for (const o of list(i.intake?.company_offerings, 6)) {
    const n = clean(o?.name, 100);
    if (n) sells.push(`- Oferta «${n}»${o?.for_whom ? ` para ${clean(o.for_whom, 120)}` : ""}${o?.problem ? `: ${clean(o.problem, 200)}` : ""}`);
  }
  const proof = list(i.intake?.social_proof, 4).map((p) => clean(typeof p === "string" ? p : [p?.client, p?.result].filter(Boolean).join(": "), 200)).filter(Boolean);
  if (proof.length) sells.push(`- Prueba social que SÍ puedes citar: ${proof.join("; ")}`);
  sec(`LO QUE OFRECE ${clean(i.company, 60).toUpperCase() || "EL EQUIPO"}`, sells);

  const prices = contextPrices(i.intake);
  sec("PRECIOS Y CONDICIONES DEL CONTEXTO", prices.length
    ? prices.map((p) => `- ${p}`)
    : ["- El Contexto no tiene precios: no menciones ninguno. Si preguntan, una persona del equipo se lo confirma."]);

  const objections = list(i.intake?.common_objections, 6)
    .map((o) => typeof o === "string" ? clean(o, 200) : (o?.objection ? `«${clean(o.objection, 150)}»${o.neutralizer ? ` → ${clean(o.neutralizer, 200)}` : ""}` : ""))
    .filter(Boolean);
  sec("OBJECIONES CONOCIDAS Y CÓMO RESPONDERLAS", objections.map((o) => `- ${o}`));

  const about: string[] = [];
  if (i.inbound?.length) about.push(`Lo que escribió el lead (más reciente al final): ${i.inbound.map((m) => `«${clean(m, 280)}»`).join(" ")}`);
  if (i.attestedNote) about.push(`Cómo pidió el contacto, según el vendedor: ${clean(i.attestedNote, 300)}`);
  if (i.lead.notes) about.push(`Notas del vendedor: ${clean(i.lead.notes, 700)}`);
  const a = i.research?.angle;
  if (a && typeof a === "object") {
    if (a.headline) about.push(`Ángulo sugerido: ${clean(a.headline, 200)}`);
    if (a.pain) about.push(`Dolor probable: ${clean(a.pain, 250)}`);
    if (a.avoid) about.push(`Evitar: ${clean(a.avoid, 200)}`);
  }
  if (i.research?.company?.summary) about.push(`Su empresa: ${clean(i.research.company.summary, 400)}`);
  sec("SOBRE ESTE LEAD", about.map((x) => `- ${x}`));

  if (i.learned) L.push("", clean(i.learned, 1_500));
  if (i.trainingBlock) L.push(i.trainingBlock.trim().slice(0, 5_600));

  sec("CIERRE", [
    "Antes de despedirte, resume en una frase lo acordado y el siguiente paso (quién hace qué y cuándo). Agradece y termina con la herramienta end_call.",
  ]);
  return L.join("\n").trim().slice(0, 16_000);
}

// ───────────────────────────────────────────────────────────────────────────
// Análisis al terminar (lo extrae el proveedor con este esquema)
// ───────────────────────────────────────────────────────────────────────────

export const ANALYSIS_FIELDS = [
  {
    type: "enum", name: "outcome", choices: MODEL_OUTCOMES,
    description:
      "Resultado de la llamada. confirmed = confirmó la reunión; rescheduled = acordó un horario nuevo; qualified = encaja y quiere avanzar; not_qualified = no encaja; wants_human = pidió hablar con una persona o se transfirió; call_back_later = pidió que lo llamen en otro momento; not_interested = no le interesa; do_not_call = pidió que no lo llamen más; wrong_person = no era la persona; no_conversation = no hubo conversación útil.",
  },
  { type: "string", name: "summary", description: "Resumen en español de 2 o 3 frases: qué dijo el lead y qué se acordó. Sin inventar." },
  { type: "string", name: "next_step", description: "UN siguiente paso concreto para el equipo (quién, qué y cuándo), en español. Vacío si no hay." },
  { type: "string", name: "new_meeting_at", description: "Si se acordó un horario nuevo o se confirmó uno, fecha y hora en ISO 8601 con zona horaria (ej. 2026-10-23T10:00:00-05:00). Vacío si no." },
  { type: "string", name: "callback_at", description: "Si pidió que lo llamen después, cuándo, en ISO 8601 con zona horaria. Vacío si no." },
  { type: "string", name: "qualification", description: "Respuestas del lead a las preguntas de calificación, una por línea («Pregunta: respuesta»). Vacío si no se calificó." },
  { type: "boolean", name: "recording_declined", description: "true si la persona pidió que la llamada no se grabara." },
];

export interface CallResult {
  status: "ended" | "failed";
  outcome: VoiceOutcome;
  durationSeconds: number;
  summary: string;
  nextStep: string;
  qualification: string;
  newMeetingAt: string | null;
  callbackAt: string | null;
  transcript: string;
  recordingDeclined: boolean;
  transferred: boolean;
  disconnection: string;
  providerCostCents: number | null;
}

const NO_ANSWER = new Set(["dial_no_answer", "dial_busy", "user_declined"]);
const VOICEMAIL = new Set(["voicemail_reached", "ivr_reached"]);
const TRANSFERRED = new Set(["call_transfer", "transfer_bridged"]);
const FAILED = new Set([
  "dial_failed", "invalid_destination", "telephony_provider_permission_denied", "telephony_provider_unavailable",
  "sip_routing_error", "marked_as_spam", "network_blocked", "concurrency_limit_reached", "no_concurrency_fallback",
  "no_valid_payment", "credit_exhausted", "budget_reached", "scam_detected", "registered_call_timeout",
  "error_llm_websocket_open", "error_llm_websocket_lost_connection", "error_llm_websocket_runtime",
  "error_llm_websocket_corrupt_payload", "error_no_audio_received", "error_asr", "error_retell", "error_unknown",
  "error_user_not_joined",
]);

/** ISO válido entre ahora y 180 días, o null. */
export function futureIso(v: unknown, now = Date.now()): string | null {
  const t = Date.parse(String(v ?? ""));
  if (!Number.isFinite(t) || t < now - 60_000 || t > now + 180 * 86_400_000) return null;
  return new Date(t).toISOString();
}

/** Llamada terminada del proveedor (objeto `call` de Retell) → resultado normalizado. */
export function normalizeCallResult(call: Json, now = Date.now()): CallResult {
  const disc = String(call?.disconnection_reason ?? "");
  const an = call?.call_analysis && typeof call.call_analysis === "object" ? call.call_analysis : {};
  const custom = an.custom_analysis_data && typeof an.custom_analysis_data === "object" ? an.custom_analysis_data : {};
  const dur = Math.max(0, Math.round(Number(call?.duration_ms ?? 0) / 1000));
  let outcome: VoiceOutcome;
  let status: CallResult["status"] = "ended";
  if (NO_ANSWER.has(disc)) outcome = "no_answer";
  else if (VOICEMAIL.has(disc) || an.in_voicemail === true) outcome = "voicemail";
  else if (FAILED.has(disc)) { outcome = "failed"; status = "failed"; }
  else if (disc === "user_requested_dnc") outcome = "do_not_call";
  else if (TRANSFERRED.has(disc)) outcome = "wants_human";
  else if (isOutcome(custom.outcome) && MODEL_OUTCOMES.includes(custom.outcome)) outcome = custom.outcome;
  else outcome = dur < 15 ? "no_conversation" : "unknown";
  // Una falla de discado no conecta: nada que cobrar aunque el proveedor informe segundos de timbre.
  const connected = !(outcome === "no_answer" || status === "failed");
  return {
    status,
    outcome,
    durationSeconds: connected ? dur : 0,
    summary: clean(custom.summary, 1_200) || clean(an.call_summary, 1_200),
    nextStep: clean(custom.next_step, 400),
    qualification: typeof custom.qualification === "string" ? custom.qualification.trim().slice(0, 2_000) : "",
    newMeetingAt: outcome === "rescheduled" || outcome === "confirmed" ? futureIso(custom.new_meeting_at, now) : null,
    callbackAt: outcome === "call_back_later" ? futureIso(custom.callback_at, now) : null,
    transcript: typeof call?.transcript === "string" ? call.transcript.slice(0, 60_000) : "",
    recordingDeclined: custom.recording_declined === true || custom.recording_declined === "true",
    transferred: TRANSFERRED.has(disc),
    disconnection: disc,
    providerCostCents: Number.isFinite(Number(call?.call_cost?.combined_cost)) ? Number(call.call_cost.combined_cost) : null,
  };
}

const EARLY_STATUSES = ["", "no_contactado", "en_campana", "saludo_enviado", "conexion_enviada", "conexion_aceptada"];

/** Estado del CRM después de la llamada, o null si no cambia. Nunca baja una reunión tomada. */
export function contactStatusAfter(outcome: VoiceOutcome, current: string | null | undefined): string | null {
  const cur = String(current ?? "");
  if (outcome === "confirmed" || outcome === "rescheduled") {
    return cur === "reunion_tomada" || cur === "reunion_agendada" ? null : "reunion_agendada";
  }
  // «No me llamen» bloquea solo las llamadas (lista «No contactar», canal phone): el CRM no cambia.
  if (outcome === "not_interested") return MEETING_STATUSES.includes(cur) ? null : "no_interesado";
  if (["qualified", "wants_human", "call_back_later", "not_qualified"].includes(outcome)) {
    return EARLY_STATUSES.includes(cur) ? "respondio" : null;
  }
  return null;
}

/** ¿Hubo conversación con la persona? (para detener campañas y contar respuestas). */
export function hadConversation(outcome: VoiceOutcome): boolean {
  return !["no_answer", "voicemail", "no_conversation", "failed", "unknown", "wrong_person"].includes(outcome);
}

/** Texto de la burbuja de la Bandeja. */
export function inboxBody(r: Pick<CallResult, "outcome" | "summary" | "nextStep">, purpose: VoicePurpose): string {
  return [
    `Llamada del agente de voz (${PURPOSE_LABEL[purpose].toLowerCase()}) · ${OUTCOME_LABEL[r.outcome]}`,
    r.summary,
    r.nextStep ? `Siguiente paso: ${r.nextStep}` : "",
  ].filter(Boolean).join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Firma del webhook de Retell: x-retell-signature = "v=<ms>,d=<hex>" con
// HMAC-SHA256(api_key, cuerpo_crudo + ms), 5 minutos de tolerancia. Igual que
// `verify` de retell-typescript-sdk (src/lib/webhook_auth.ts).
// ───────────────────────────────────────────────────────────────────────────

export async function retellSign(body: string, apiKey: string, ts = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body + ts));
  return `v=${ts},d=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function verifyRetellSignature(body: string, apiKey: string, signature: string | null, now = Date.now()): Promise<boolean> {
  if (!apiKey || !signature) return false;
  const m = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!m) return false;
  const ts = Number(m[1]);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > 5 * 60_000) return false;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(m[2].slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body + ts));
}

// ───────────────────────────────────────────────────────────────────────────
// Horarios para ofrecer al reprogramar (agenda de Google Calendar)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hasta `max` huecos libres de `minutes` minutos en horario de oficina del
 * país (L-V 9:00-18:00), desde mañana y por 7 días, a partir de los
 * intervalos ocupados de freeBusy. Como mucho dos por día para repartirlos.
 */
export function freeSlots(
  busy: { start: string; end: string }[],
  now: Date,
  country: VoiceCountry,
  minutes = 30,
  max = 6,
): { iso: string; label: string }[] {
  const intervals = busy
    .map((b) => [Date.parse(b.start), Date.parse(b.end)] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const out: { iso: string; label: string }[] = [];
  const perDay: Record<string, number> = {};
  const step = 30 * 60_000;
  // Primer múltiplo de 30 min desde mañana a esta hora (sin ofrecer horarios de hoy).
  let t = Math.ceil((now.getTime() + 18 * 3_600_000) / step) * step;
  const end = now.getTime() + 8 * 86_400_000;
  for (; t < end && out.length < max; t += step) {
    const p = localParts(country, new Date(t));
    if (p.dow === 0 || p.dow === 6 || isHoliday(country, p.year, p.mmdd)) continue;
    const startMin = p.hour * 60 + p.minute;
    if (startMin < 9 * 60 || startMin + minutes > 18 * 60) continue;
    if ((perDay[p.mmdd] ?? 0) >= 2) continue;
    const s = t, e = t + minutes * 60_000;
    if (intervals.some(([a, b]) => s < b && e > a)) continue;
    perDay[p.mmdd] = (perDay[p.mmdd] ?? 0) + 1;
    out.push({ iso: new Date(s).toISOString(), label: meetingLabel(new Date(s).toISOString(), country) });
    t += 2 * 3_600_000 - step; // separa los huecos del mismo día
  }
  return out;
}
