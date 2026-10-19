/**
 * sales-training — el "Predictable de cada empresa" (2026-09-23).
 *
 * Cada cuenta entrena su IA de ventas desde la página «Entrenamiento IA»
 * (js/ai-training.js) con lo que solo ella sabe: su base de conocimiento
 * (playbooks, casos, precios, battlecards… destilados a principios por la
 * edge function `ai-training`), su estilo de comunicación, reglas propias
 * (siempre / nunca) y la personalidad del coach.
 *
 * El catálogo de metodologías de venta (libros: SPIN, Challenger, Sandler…)
 * se quitó el 2026-10-19 a pedido del dueño: quien no los leyó no sabía
 * cuáles elegir. Las columnas `coach_methods` / `campaign_methods` de
 * `ai_training` quedan en la tabla pero ya no se leen: el coach usa siempre
 * NEURO_DOCTRINE. No lo resucites.
 *
 * Este archivo es la ÚNICA definición de cómo ese entrenamiento se convierte
 * en instrucciones para el modelo. Lo consumen:
 *   - sales-coach       → coachDoctrine() + buildTrainingBlock('coach' |
 *                         'coach_live').
 *   - generate-outreach → buildTrainingBlock('outreach') (pasos, respuestas
 *                         de la Bandeja y la preparación del coach).
 *   - generate-campaign → buildTrainingBlock('cadence').
 *   - ai-training       → vista previa y el prompt del coach en vivo por el
 *                         worker de OpenAI (js/realtime-coach.js).
 *
 * Reglas de precedencia (van dentro del bloque, el modelo las lee):
 *   - El entrenamiento personaliza voz, enfoque y conocimiento.
 *   - NUNCA anula la prohibición de inventar datos ni el formato del canal
 *     (largo máximo, apertura obligatoria, JSON de salida).
 *   - El tratamiento (tú/usted) y los emojis del bloque ESTILO sí reemplazan
 *     los valores por defecto de los prompts.
 * Sin fila de entrenamiento (o sin la tabla, migración sin aplicar) todo se
 * comporta exactamente como antes: doctrina de neuroventas y cero bloques.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

// "voice" = el agente de voz IA (docs/AGENTE_DE_VOZ.md): lado campañas, bloque
// corto (latencia de cada turno) y SIN documentos de precios — en una llamada
// solo se mencionan los precios y condiciones del Contexto.
export type TrainingTarget = "coach" | "coach_live" | "outreach" | "cadence" | "voice";

// ───────────────────────────────────────────────────────────────────────────
// Doctrina del coach. NEURO_DOCTRINE es la de siempre (2026-09-18) y la única
// desde que se quitaron las metodologías elegibles (2026-10-19).
// ───────────────────────────────────────────────────────────────────────────
const COACH_OBJECTIONS_AND_RULES = [
  "MANEJO DE OBJECIONES (siempre en 3 movimientos):",
  "a) Valida la emoción sin discutir ('tiene sentido que te preocupe X').",
  "b) Reencuadra hacia el miedo o el deseo dominante del lead (¿qué pierde si no cambia?).",
  "c) Cierra con una pregunta que lo lleve a un sí pequeño.",
  "Nunca pelees con la herramienta o el proveedor actual: reencuadra el costo de quedarse igual.",
  "",
  "OPORTUNIDADES: cada dato del lead (dolor, meta, plazo, presupuesto, quién decide) es una puerta.",
  "Si el vendedor la deja pasar, dile exactamente qué preguntar para abrirla.",
  "",
  "REGLAS DURAS:",
  "- Nunca recomiendes pitchear antes de tener el dolor claro y en palabras del propio lead.",
  "- Si el vendedor habla más del 60 % del tiempo, ordénale callarse y preguntar.",
  "- Sin siguiente paso acordado con fecha no hay cierre: fuérzalo antes de despedirse.",
  "- Español neutro latinoamericano (tú). Sin emojis en las frases sugeridas. Sin jerga en inglés.",
  "- NUNCA inventes datos, cifras, nombres ni citas. Todo sale del transcript o del contexto entregado.",
];

export const NEURO_DOCTRINE = [
  "IDENTIDAD: eres un entrenador de neuroventas formado en la escuela de Jürgen Klarić.",
  "Hablas directo, con energía, sin rodeos, como un coach al oído del vendedor. Frases cortas.",
  "Tu trabajo NO es explicar teoría: es decirle al vendedor QUÉ HACER en este instante.",
  "",
  "PRINCIPIOS DE NEUROVENTAS (en este orden):",
  "1. Véndele a la mente, no a la gente: el 85 % de la decisión es inconsciente. Habla primero al cerebro",
  "   reptil (miedo a perder, seguridad, poder, ahorrar energía/tiempo), luego al límbico (emoción,",
  "   historia, pertenencia) y al final al córtex (datos, precio, comparativas).",
  "2. Reduce el miedo antes de vender: el cerebro compra para evitar dolor y reducir incertidumbre.",
  "   Nombra el miedo del lead, valídalo y muéstrale que contigo pierde menos.",
  "3. Menos es más: el cerebro se cansa. Una idea por frase, tres beneficios máximo, cero jerga.",
  "4. Hazlo tangible: ejemplos concretos, cifras del propio lead, historias de clientes parecidos.",
  "   Nunca inventes casos: si no hay una historia real en el contexto, usa la del propio lead.",
  "5. Usa la palabra 'tú' y el nombre del lead. Verbos de acción, presente, positivo.",
  "6. Descubre el código reptil del lead (¿qué lo mueve: control, reconocimiento, seguridad,",
  "   crecimiento, ahorro?) y vende en ese código, no en las características del producto.",
  "7. Pregunta más de lo que afirmas: quien pregunta controla. El lead debe hablar más que el vendedor.",
  "8. El cierre es un permiso, no una presión: micro-síes, siguiente paso concreto con fecha.",
  "",
  ...COACH_OBJECTIONS_AND_RULES,
].join("\n");

/** Doctrina del coach: la misma para todas las cuentas. */
export function coachDoctrine(): string {
  return NEURO_DOCTRINE;
}

// ───────────────────────────────────────────────────────────────────────────
// Bloque de entrenamiento
// ───────────────────────────────────────────────────────────────────────────
export const DOC_KINDS: Record<string, string> = {
  book: "Material de ventas",
  playbook: "Playbook interno",
  case: "Caso de éxito",
  pricing: "Precios y oferta",
  battlecard: "Competencia / battlecard",
  call: "Llamada o mensaje modelo",
  other: "Otro",
};

const ADDRESS: Record<string, string> = {
  tu: "Trata al lead de TÚ.",
  usted: "Trata al lead de USTED (reemplaza el tuteo por defecto en todo lo que va dirigido al lead).",
};
const LENGTH: Record<string, string> = {
  breve: "Mensajes y frases lo más breves posible.",
  medio: "Largo medio: completo pero sin relleno.",
  detallado: "Puedes extenderte un poco más cuando aporte contexto (sin pasar el máximo del canal).",
};
const EMOJIS: Record<string, string> = {
  nunca: "Sin emojis.",
  a_veces: "Un emoji ocasional está permitido en WhatsApp y LinkedIn, nunca en email ni en frases del coach.",
};

export interface TrainingRow {
  style?: Json;
  coach_persona?: string | null;
  rules_always?: string | null;
  rules_never?: string | null;
}

export interface TrainingDoc {
  title?: string | null;
  kind?: string | null;
  summary?: string | null;
  status?: string | null;
  enabled?: boolean | null;
  apply_coach?: boolean | null;
  apply_campaigns?: boolean | null;
}

export interface Training {
  row: TrainingRow | null;
  docs: TrainingDoc[];
  /** Solo para el coach: lo que vende esta empresa (de intel_hub_intake). */
  company?: Json | null;
}

const BUDGET: Record<TrainingTarget, number> = {
  coach_live: 6_000,
  coach: 10_000,
  outreach: 9_000,
  cadence: 4_000,
  voice: 5_000,
};

function txt(v: unknown, max = 1_200): string {
  return typeof v === "string" ? v.trim().replace(/\s+\n/g, "\n").slice(0, max) : "";
}

/**
 * Arrays JSONB del contexto a texto: social_proof [{client, industry, result}],
 * common_objections [{objection, neutralizer}], competitors [{name, domain}].
 */
function arr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (typeof x === "string") return x.trim();
    if (!x || typeof x !== "object") return "";
    if (x.objection) return x.neutralizer ? `"${x.objection}" → ${x.neutralizer}` : `"${x.objection}"`;
    if (x.client) return `${x.client}${x.industry ? ` (${x.industry})` : ""}${x.result ? `: ${x.result}` : ""}`;
    return String(x.name ?? x.label ?? "").trim();
  }).filter(Boolean).map((s) => s.slice(0, 300));
}

/** Lo que vende la empresa, para que el coach sepa qué defender en la reunión. */
function companyLines(c: Json): string[] {
  if (!c || typeof c !== "object") return [];
  const out: string[] = [];
  const add = (label: string, v: unknown, max = 500) => { const s = txt(v, max); if (s) out.push(`${label}: ${s}`); };
  add("A qué se dedica", c.company_about);
  add("Soluciones", c.company_solutions);
  add("Propuesta de valor", c.value_proposition);
  add("Problema que resuelve", c.value_problem_solved);
  add("Casos de éxito", c.value_success_cases, 700);
  const proof = arr(c.social_proof);
  if (proof.length) out.push(`Prueba social real: ${proof.slice(0, 6).join("; ")}`);
  else add("Prueba social real", c.social_proof, 600);
  const comp = arr(c.competitors);
  if (comp.length) out.push(`Competidores: ${comp.slice(0, 8).join(", ")}`);
  const obj = arr(c.common_objections);
  if (obj.length) out.push(`Objeciones que el equipo ya conoce: ${obj.slice(0, 8).join("; ")}`);
  else add("Objeciones que el equipo ya conoce", c.common_objections, 600);
  add("Ticket y ciclo", [c.commercial_deal_size, c.commercial_sales_cycle].filter(Boolean).join(" · "), 200);
  return out;
}

/** ¿Hay algo que el modelo deba leer? (evita bloques vacíos con encabezado). */
export function hasTraining(t: Training | null | undefined): boolean {
  if (!t) return false;
  const r = t.row ?? {};
  const s = r.style ?? {};
  return !!(
    txt(r.coach_persona) || txt(r.rules_always) || txt(r.rules_never) ||
    (s && typeof s === "object" && Object.values(s).some((v) => typeof v === "string" ? v.trim() : !!v)) ||
    usableDocs(t.docs, "outreach").length || usableDocs(t.docs, "coach").length
  );
}

function usableDocs(docs: TrainingDoc[] | null | undefined, target: TrainingTarget): TrainingDoc[] {
  const coachSide = target === "coach" || target === "coach_live";
  return (docs ?? []).filter((d) =>
    d && d.enabled !== false && d.status === "done" && txt(d.summary) &&
    (coachSide ? d.apply_coach !== false : d.apply_campaigns !== false) &&
    !(target === "voice" && d.kind === "pricing")
  );
}

/**
 * Bloque de texto que se añade al prompt. Vacío si no hay nada entrenado.
 * El presupuesto de caracteres por destino protege al coach en vivo (latencia)
 * y a los mensajes (contexto ya largo): los documentos se recortan al final.
 */
export function buildTrainingBlock(t: Training | null | undefined, target: TrainingTarget): string {
  if (!t) return "";
  const r = t.row ?? {};
  const coachSide = target === "coach" || target === "coach_live";
  const lines: string[] = [];

  if (coachSide) {
    const persona = txt(r.coach_persona, 800);
    if (persona) lines.push("PERSONALIDAD DEL COACH (cómo quiere el equipo que le hables):", persona, "");
    const company = companyLines(t.company);
    if (company.length) {
      lines.push("LO QUE VENDE ESTE EQUIPO (úsalo para las frases sugeridas; nada fuera de esto):", ...company.map((l) => `- ${l}`), "");
    }
  }

  const s = (r.style && typeof r.style === "object") ? r.style : {};
  const style: string[] = [];
  if (ADDRESS[s.address]) style.push(ADDRESS[s.address]);
  if ((!coachSide || target === "coach") && target !== "voice") {
    if (LENGTH[s.length]) style.push(LENGTH[s.length]);
    if (EMOJIS[s.emojis]) style.push(EMOJIS[s.emojis]);
  }
  const voice = txt(s.voice, 600);
  if (voice) style.push(`Cómo suena el equipo: ${voice}`);
  const use = txt(s.words_use, 500);
  if (use) style.push(`Palabras y expresiones propias que SÍ usan: ${use}`);
  const avoid = txt(s.words_avoid, 500);
  if (avoid) style.push(`Palabras y expresiones PROHIBIDAS: ${avoid}`);
  const examples = target === "cadence" ? "" : txt(s.examples, target === "coach_live" || target === "voice" ? 800 : 1_800);
  if (examples) style.push("Ejemplos reales de su voz (imita el tono y el ritmo, NUNCA copies el contenido ni sus datos):", examples);
  if (style.length) {
    lines.push(
      coachSide
        ? "ESTILO DE COMUNICACIÓN DEL EQUIPO (aplica a las frases que el vendedor le dirá al lead):"
        : "ESTILO DE COMUNICACIÓN DEL EQUIPO:",
      ...style.map((l) => (l.startsWith("Ejemplos") || l.includes("\n") ? l : `- ${l}`)), "",
    );
  }

  const always = txt(r.rules_always, 900);
  const never = txt(r.rules_never, 900);
  if (always || never) {
    lines.push("REGLAS DEL EQUIPO:");
    if (always) lines.push(`SIEMPRE: ${always}`);
    if (never) lines.push(`NUNCA: ${never}`);
    lines.push("");
  }

  const docs = target === "cadence" ? [] : usableDocs(t.docs, target);
  if (docs.length) {
    const used = lines.join("\n").length;
    let room = BUDGET[target] - used - 400;
    const perDoc = Math.max(400, Math.floor(room / docs.length));
    const docLines: string[] = [];
    for (const d of docs) {
      if (room < 300) break;
      const body = txt(d.summary, Math.min(perDoc, room));
      const label = DOC_KINDS[String(d.kind)] ?? DOC_KINDS.other;
      docLines.push(`[${label}] ${txt(d.title, 120) || "Documento"}:`, body, "");
      room -= body.length + 80;
    }
    if (docLines.length) {
      lines.push("CONOCIMIENTO PROPIO DEL EQUIPO (destilado de sus documentos; úsalo como fuente de verdad):", ...docLines);
    }
  }

  if (!lines.length) return "";
  return [
    "",
    "=== ENTRENAMIENTO DE ESTE EQUIPO (configurado por ellos en «Entrenamiento IA») ===",
    "Personaliza tu voz, tu enfoque y tu conocimiento con este bloque. NUNCA anula la prohibición de",
    "inventar datos ni el formato de salida o el largo máximo del canal. El tratamiento (tú/usted) y",
    "los emojis indicados aquí SÍ reemplazan los valores por defecto.",
    "",
    ...lines,
  ].join("\n").trimEnd().slice(0, BUDGET[target] + 600);
}

// ───────────────────────────────────────────────────────────────────────────
// Carga (service role). Tolerante: tabla ausente o error → sin entrenamiento.
// ───────────────────────────────────────────────────────────────────────────
const COMPANY_COLS =
  "company_about, company_solutions, value_proposition, value_problem_solved, value_success_cases, social_proof, competitors, common_objections, commercial_deal_size, commercial_sales_cycle";

export async function loadTraining(
  // deno-lint-ignore no-explicit-any
  supa: any,
  userId: string | null | undefined,
  opts: { company?: boolean } = {},
): Promise<Training> {
  const empty: Training = { row: null, docs: [], company: null };
  if (!userId) return empty;
  try {
    const [rowRes, docsRes, companyRes] = await Promise.all([
      supa.from("ai_training").select("style, coach_persona, rules_always, rules_never")
        .eq("user_id", userId).maybeSingle(),
      supa.from("ai_training_docs").select("title, kind, summary, status, enabled, apply_coach, apply_campaigns")
        .eq("user_id", userId).eq("enabled", true).eq("status", "done")
        .order("created_at", { ascending: true }).limit(30),
      opts.company
        ? supa.from("intel_hub_intake").select(COMPANY_COLS).eq("user_id", userId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    return {
      row: rowRes?.error ? null : (rowRes?.data ?? null),
      docs: docsRes?.error ? [] : (docsRes?.data ?? []),
      company: companyRes?.error ? null : (companyRes?.data ?? null),
    };
  } catch (e) {
    console.warn("[sales-training] load failed, sin entrenamiento:", e);
    return empty;
  }
}
