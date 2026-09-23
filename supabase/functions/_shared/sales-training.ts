/**
 * sales-training — el "Predictable de cada empresa" (2026-09-23).
 *
 * Cada cuenta entrena su IA de ventas desde la página «Entrenamiento IA»
 * (js/ai-training.js): qué metodologías de venta aplica el Meeting Coach y
 * cuáles las campañas, su estilo de comunicación, reglas propias (siempre /
 * nunca), la personalidad del coach y su base de conocimiento (libros,
 * playbooks, casos, battlecards… destilados a principios por la edge
 * function `ai-training`).
 *
 * Este archivo es la ÚNICA definición de cómo ese entrenamiento se convierte
 * en instrucciones para el modelo. Lo consumen:
 *   - sales-coach       → coachDoctrine() reemplaza la doctrina fija y
 *                         buildTrainingBlock('coach' | 'coach_live').
 *   - generate-outreach → buildTrainingBlock('outreach') (pasos, respuestas
 *                         de la Bandeja y la preparación del coach).
 *   - generate-campaign → buildTrainingBlock('cadence').
 *   - ai-training       → vista previa y el prompt del coach en vivo por el
 *                         worker de OpenAI (js/realtime-coach.js).
 *
 * `METHODOLOGIES` es espejo de `METHODS` en js/ai-training.js (ids, nombre,
 * autor, libro, foco): se cambian juntos — `sales-training.test.ts` lo
 * verifica. Los principios están escritos con palabras propias: son el
 * resumen operativo de cada marco, nunca texto copiado de los libros.
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

export type TrainingTarget = "coach" | "coach_live" | "outreach" | "cadence";

export interface Methodology {
  id: string;
  name: string;
  author: string;
  book: string;
  /** Dónde brilla: sirve para la recomendación de la UI, no limita su uso. */
  focus: "coach" | "campaigns" | "both";
  /** Cómo aplica el coach (reunión en vivo y reporte). */
  coach: string[];
  /** Cómo aplica en mensajes de campaña y diseño de cadencias. */
  outreach: string[];
}

export const DEFAULT_COACH_METHODS = ["neuroventas"];

export const METHODOLOGIES: Methodology[] = [
  {
    id: "neuroventas", name: "Neuroventas", author: "Jürgen Klarić", book: "Véndele a la mente, no a la gente", focus: "both",
    coach: [
      "Véndele primero al cerebro reptil (miedo a perder, seguridad, poder, ahorrar energía), luego a la emoción y al final a los datos.",
      "Descubre el código reptil del lead (control, reconocimiento, seguridad, crecimiento, ahorro) y vende en ese código.",
      "Menos es más: una idea por frase, tres beneficios como máximo, cero jerga.",
    ],
    outreach: [
      "Abre con lo que el lead pierde o arriesga hoy, no con lo que tú haces.",
      "Una sola idea por mensaje; lo tangible (una cifra o escena del propio lead) vence a la lista de beneficios.",
    ],
  },
  {
    id: "spin", name: "SPIN Selling", author: "Neil Rackham", book: "SPIN Selling", focus: "coach",
    coach: [
      "Ordena el descubrimiento en Situación → Problema → Implicación → Necesidad-beneficio.",
      "Pocas preguntas de situación (aburren al lead); invierte el tiempo en las de implicación: qué le cuesta el problema en dinero, tiempo, riesgo y personas.",
      "Que el lead diga en voz alta el beneficio de resolverlo (preguntas de necesidad-beneficio) antes de mostrar la solución.",
      "En ventas complejas el objetivo de cada reunión es un avance concreto, no solo una buena conversación.",
    ],
    outreach: [
      "Formula el gancho como una pregunta de implicación ('cuando X pasa, ¿cuánto se retrasa Y?') en lugar de afirmar el dolor.",
    ],
  },
  {
    id: "challenger", name: "The Challenger Sale", author: "Matthew Dixon y Brent Adamson", book: "The Challenger Sale", focus: "both",
    coach: [
      "Enseña: lleva un insight comercial que cambie cómo el lead ve su propio problema (algo que no sabía y le cuesta).",
      "Adapta el mensaje a cada perfil de la mesa (usuario, financiero, decisor): qué gana y qué arriesga cada uno.",
      "Toma el control con respeto: sostén tu recomendación ante la presión de precio o de plazos, sin agresividad.",
      "Construye la tensión constructiva: nombra el costo de seguir igual antes de hablar de tu solución.",
    ],
    outreach: [
      "Cada mensaje trae un reencuadre: una idea que desafía la forma en que su industria resuelve el problema.",
      "Evita el 'queremos presentarte': el valor es la idea, no la reunión.",
    ],
  },
  {
    id: "sandler", name: "Sandler", author: "David Sandler", book: "You Can't Teach a Kid to Ride a Bike at a Seminar", focus: "coach",
    coach: [
      "Arranca con un contrato inicial: objetivo de la llamada, tiempo, y que al final ambos decidan si hay siguiente paso (un 'no' también vale).",
      "Embudo del dolor: de lo superficial a lo personal (¿desde cuándo?, ¿qué intentaste?, ¿cuánto te cuesta?, ¿cómo te afecta a ti?).",
      "Califica presupuesto y proceso de decisión ANTES de presentar.",
      "Venta inversa: cuando el lead empuja, retrocede un paso ('quizá no es prioridad hoy') para que él argumente a favor.",
    ],
    outreach: [
      "Tono sin necesidad: está bien que no sea para ellos; invita a descartar rápido.",
    ],
  },
  {
    id: "meddicc", name: "MEDDICC", author: "Jack Napoli y Dick Dunkel (PTC)", book: "MEDDIC / MEDDICC", focus: "coach",
    coach: [
      "Califica el deal en voz alta: Métricas (impacto medible), Economic buyer (quién firma), Criterios de decisión, Proceso de decisión, Identificar el dolor, Champion y Competencia.",
      "Cada reunión debe dejar al menos una letra más confirmada; marca como riesgo la que siga vacía.",
      "Sin economic buyer identificado ni proceso de decisión claro, el deal no avanza aunque la reunión haya sido buena.",
    ],
    outreach: [
      "Apunta el mensaje al dolor que el economic buyer mide, no a la tarea del usuario.",
    ],
  },
  {
    id: "gap_selling", name: "Gap Selling", author: "Keenan", book: "Gap Selling", focus: "coach",
    coach: [
      "Mapea el estado actual (cómo operan hoy, problemas, impacto, causa raíz) y el estado futuro que desean.",
      "Vendes la brecha entre ambos: cuanto más grande y más clara para el lead, más urgente la decisión.",
      "Céntrate en el problema, no en el producto: si no hay brecha no hay venta, dilo con honestidad.",
    ],
    outreach: [
      "Describe en una frase el estado actual típico del rol y el costo de esa brecha, sin pitchear el producto.",
    ],
  },
  {
    id: "voss", name: "Negociación táctica", author: "Chris Voss", book: "Never Split the Difference", focus: "coach",
    coach: [
      "Empatía táctica: etiqueta la emoción del lead ('parece que te preocupa…') y deja que la confirme.",
      "Espejo: repite sus últimas 2-3 palabras en tono de pregunta para que siga hablando.",
      "Preguntas calibradas con '¿cómo…?' y '¿qué…?' en lugar de '¿por qué…?' (que suena a juicio).",
      "Auditoría de acusaciones: nombra tú primero lo negativo que el lead podría pensar.",
      "Busca un 'eso es correcto' más que un 'sí' de cortesía; un 'no' da seguridad y abre la negociación.",
    ],
    outreach: [
      "Usa preguntas orientadas al 'no' ('¿sería una locura revisar…?') en el CTA.",
    ],
  },
  {
    id: "jolt", name: "The JOLT Effect", author: "Matthew Dixon y Ted McKenna", book: "The JOLT Effect", focus: "coach",
    coach: [
      "Muchas ventas se pierden por indecisión, no por la competencia: detecta el miedo a equivocarse.",
      "Juzga el nivel de indecisión, Ofrece una recomendación clara ('en tu caso yo haría X'), Limita la exploración (no abras más opciones) y quita el riesgo de la mesa (pilotos, garantías, pasos pequeños).",
    ],
    outreach: [
      "En seguimientos a leads tibios, reduce opciones y propone un único paso de bajo riesgo.",
    ],
  },
  {
    id: "predictable_revenue", name: "Predictable Revenue", author: "Aaron Ross y Marylou Tyler", book: "Predictable Revenue", focus: "campaigns",
    coach: [
      "Una reunión de descubrimiento califica, no vende: confirma encaje con el ICP y agenda el paso con quien decide.",
    ],
    outreach: [
      "Mensajes cortos, en texto plano, escritos como de persona a persona; nada de folleto.",
      "Pide dirección antes que reunión cuando no sabes si es la persona correcta ('¿quién ve X en tu equipo?').",
      "Especialización: cada campaña apunta a un ICP y un dolor; no mezcles mensajes para todos.",
    ],
  },
  {
    id: "fanatical_prospecting", name: "Prospección fanática", author: "Jeb Blount", book: "Fanatical Prospecting", focus: "campaigns",
    coach: [
      "Pide la reunión o el siguiente paso de forma directa y asume el sí; luego calla.",
    ],
    outreach: [
      "Multicanal y constante: cada toque es breve y en un canal distinto.",
      "Fórmula de 5 pasos: interrumpe con su nombre, identifícate, di por qué escribes, un 'porque' que conecte con su mundo, y pide lo que quieres.",
      "Ten lista la respuesta a los reflejos típicos ('mándame info', 'no me interesa') y responde con una pregunta.",
    ],
  },
  {
    id: "cialdini", name: "Influencia", author: "Robert Cialdini", book: "Influence", focus: "both",
    coach: [
      "Apóyate en los principios de persuasión con ética: reciprocidad (da valor primero), compromiso (micro-síes), prueba social REAL, autoridad, simpatía, escasez verdadera y unidad (identidad compartida).",
      "Nunca fabriques escasez ni prueba social: solo lo que exista en el contexto.",
    ],
    outreach: [
      "Da algo útil antes de pedir (dato, idea, recurso).",
      "Prueba social de pares del mismo sector o rol, solo si está en el contexto; nunca inventada.",
    ],
  },
  {
    id: "mom_test", name: "The Mom Test", author: "Rob Fitzpatrick", book: "The Mom Test", focus: "coach",
    coach: [
      "Pregunta por hechos del pasado ('¿cuándo fue la última vez que…?, ¿cómo lo resolviste?'), no por opiniones sobre el futuro.",
      "Los cumplidos y los 'me encantaría' no son señales: busca compromisos concretos (tiempo, dinero, introducciones).",
      "Habla menos de tu solución y más de su vida real con el problema.",
    ],
    outreach: [],
  },
  {
    id: "pink", name: "Vender es humano", author: "Daniel H. Pink", book: "To Sell Is Human", focus: "campaigns",
    coach: [
      "Sintonía: toma la perspectiva del lead y ajusta tu ritmo al suyo.",
      "Claridad: ayuda al lead a encontrar el problema correcto, no solo a resolver el que trae.",
    ],
    outreach: [
      "Asuntos útiles o de curiosidad concreta, específicos, nunca de relleno.",
      "Pitch en forma de pregunta cuando los argumentos son fuertes: el lead se convence solo.",
    ],
  },
];

const METHOD_BY_ID: Record<string, Methodology> = Object.fromEntries(METHODOLOGIES.map((m) => [m.id, m]));

export function isMethodology(id: unknown): id is string {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(METHOD_BY_ID, id);
}

/** Filtra ids desconocidos o repetidos; conserva el orden del usuario. */
export function cleanMethods(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const id of v) if (isMethodology(id) && !out.includes(id)) out.push(id);
  return out.slice(0, 6);
}

// ───────────────────────────────────────────────────────────────────────────
// Doctrina del coach. NEURO_DOCTRINE es la de siempre (2026-09-18) y sigue
// siendo el default: sin entrenamiento el coach habla exactamente igual.
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

function methodLines(m: Methodology, kind: "coach" | "outreach"): string[] {
  const list = kind === "coach" ? m.coach : m.outreach;
  if (!list.length) return [];
  return [`${m.name} (${m.author}, «${m.book}»):`, ...list.map((p) => `- ${p}`)];
}

/**
 * Doctrina del coach según las metodologías elegidas. Sin elección (o solo
 * neuroventas) devuelve NEURO_DOCTRINE tal cual. Con neuroventas + otras, la
 * doctrina de siempre más las otras como marcos adicionales. Sin neuroventas,
 * una identidad neutra construida con los marcos elegidos + las mismas
 * reglas duras y el mismo manejo de objeciones.
 */
export function coachDoctrine(methods: unknown): string {
  const ids = cleanMethods(methods);
  if (!ids.length || (ids.length === 1 && ids[0] === "neuroventas")) return NEURO_DOCTRINE;
  const others = ids.filter((id) => id !== "neuroventas").map((id) => METHOD_BY_ID[id]);
  const frameworks = others.flatMap((m) => [...methodLines(m, "coach"), ""]);
  if (ids.includes("neuroventas")) {
    return [
      NEURO_DOCTRINE,
      "",
      "MARCOS ADICIONALES QUE ESTE EQUIPO ENTRENA (combínalos con la doctrina de arriba; cuando",
      "una alerta aplique uno, que la frase sugerida lo refleje sin nombrar el libro):",
      ...frameworks,
    ].join("\n").trimEnd();
  }
  return [
    "IDENTIDAD: eres el entrenador de ventas de este equipo, entrenado en las metodologías que",
    "el equipo eligió. Hablas directo, con energía, sin rodeos, como un coach al oído del",
    "vendedor. Frases cortas. Tu trabajo NO es explicar teoría: es decirle QUÉ HACER ahora.",
    "Aplica los marcos en la práctica; no nombres el libro en las frases sugeridas.",
    "",
    "METODOLOGÍAS DEL EQUIPO:",
    ...frameworks,
    "PRINCIPIOS COMUNES: pregunta más de lo que afirmas (el lead debe hablar más que el",
    "vendedor), hazlo tangible con datos del propio lead y el cierre es un siguiente paso",
    "concreto con fecha.",
    "",
    ...COACH_OBJECTIONS_AND_RULES,
  ].join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Bloque de entrenamiento
// ───────────────────────────────────────────────────────────────────────────
export const DOC_KINDS: Record<string, string> = {
  book: "Libro de ventas",
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
  coach_methods?: string[] | null;
  campaign_methods?: string[] | null;
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
    cleanMethods(r.coach_methods).length || cleanMethods(r.campaign_methods).length ||
    txt(r.coach_persona) || txt(r.rules_always) || txt(r.rules_never) ||
    (s && typeof s === "object" && Object.values(s).some((v) => typeof v === "string" ? v.trim() : !!v)) ||
    usableDocs(t.docs, "outreach").length || usableDocs(t.docs, "coach").length
  );
}

function usableDocs(docs: TrainingDoc[] | null | undefined, target: TrainingTarget): TrainingDoc[] {
  const coachSide = target === "coach" || target === "coach_live";
  return (docs ?? []).filter((d) =>
    d && d.enabled !== false && d.status === "done" && txt(d.summary) &&
    (coachSide ? d.apply_coach !== false : d.apply_campaigns !== false)
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
  } else {
    const ids = cleanMethods(r.campaign_methods);
    const methods = ids.map((id) => METHOD_BY_ID[id]).flatMap((m) => methodLines(m, "outreach"));
    if (methods.length) {
      lines.push(
        target === "cadence"
          ? "METODOLOGÍAS DE PROSPECCIÓN DEL EQUIPO (que guíen canales, orden, ángulos y tono de la cadencia):"
          : "METODOLOGÍAS DE PROSPECCIÓN DEL EQUIPO (aplícalas en el mensaje sin nombrar el libro):",
        ...methods, "",
      );
    }
  }

  const s = (r.style && typeof r.style === "object") ? r.style : {};
  const style: string[] = [];
  if (ADDRESS[s.address]) style.push(ADDRESS[s.address]);
  if (!coachSide || target === "coach") {
    if (LENGTH[s.length]) style.push(LENGTH[s.length]);
    if (EMOJIS[s.emojis]) style.push(EMOJIS[s.emojis]);
  }
  const voice = txt(s.voice, 600);
  if (voice) style.push(`Cómo suena el equipo: ${voice}`);
  const use = txt(s.words_use, 500);
  if (use) style.push(`Palabras y expresiones propias que SÍ usan: ${use}`);
  const avoid = txt(s.words_avoid, 500);
  if (avoid) style.push(`Palabras y expresiones PROHIBIDAS: ${avoid}`);
  const examples = target === "cadence" ? "" : txt(s.examples, target === "coach_live" ? 800 : 1_800);
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
      supa.from("ai_training").select("coach_methods, campaign_methods, style, coach_persona, rules_always, rules_never")
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
