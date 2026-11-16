/**
 * coach-playbook — playbook del AI Sales Coach (2026-11-16).
 *
 * Qué hacer y qué decir en cada fase de la llamada, la respuesta base a cada
 * objeción típica y las reglas de los libros de venta con los que se entrena
 * el coach (METHODS). Pedido del dueño: el coach sigue SIEMPRE esas mejores
 * prácticas y sabe qué decir desde el primer segundo.
 *
 * No es el catálogo elegible que se quitó el 2026-10-19 (nadie sabía qué libro
 * elegir): aquí no se elige nada, todo se aplica siempre y por fase.
 *
 * ESPEJO EXACTO de js/coach-playbook.js (coach-playbook.test.ts): se cambian
 * juntos. En el navegador es la capa instantánea del coach en vivo; aquí,
 * playbookDoctrine() es la doctrina por fase que coachDoctrine()
 * (sales-training.ts) añade a todos los prompts del coach.
 */

export interface Stage { id: string; label: string; minutes: number; goal: string; do: string[]; say: string; method: string }
export interface Objection { id: string; title: string; patterns: string[]; say: string; why: string }
export interface Method { name: string; rule: string }

const DATA: { STAGES: Stage[]; OBJECTIONS: Objection[]; METHODS: Method[] } = {
  "STAGES": [
    {
      "id": "rapport",
      "label": "Apertura",
      "minutes": 3,
      "goal": "Ganar el permiso y fijar la agenda en los primeros minutos.",
      "do": [
        "Agradece el tiempo y confirma cuánto tienen.",
        "Acuerda la agenda y qué se decide al final de la llamada.",
        "Pide permiso para preguntar antes de mostrar nada."
      ],
      "say": "Gracias por el tiempo. Para aprovecharlo: primero quiero entender cómo lo manejan hoy, después te muestro solo lo que aplique a tu caso y al final decidimos juntos si tiene sentido un siguiente paso. ¿Te parece bien?",
      "method": "Sandler: contrato inicial"
    },
    {
      "id": "discovery",
      "label": "Descubrimiento",
      "minutes": 12,
      "goal": "Que el lead diga su dolor con sus propias palabras y le ponga número.",
      "do": [
        "Pregunta por la situación actual y por el problema.",
        "Profundiza: desde cuándo pasa, qué han intentado y qué ocurre si sigue igual.",
        "Ponle número al impacto y averigua quién más decide."
      ],
      "say": "¿Cómo lo están resolviendo hoy y qué es lo que más les cuesta de hacerlo así?",
      "method": "SPIN · embudo del dolor de Sandler · MEDDIC"
    },
    {
      "id": "reframe",
      "label": "Reencuadre",
      "minutes": 5,
      "goal": "Mostrar el costo de quedarse igual y la brecha entre hoy y lo que quiere lograr.",
      "do": [
        "Resume su dolor con sus palabras y espera a que lo confirme.",
        "Aporta una idea sobre su problema que no había visto.",
        "Pregunta qué cambia para él y para su equipo si lo resuelve."
      ],
      "say": "Déjame ver si entendí bien lo que me contaste. ¿Me faltó algo? Y si dentro de seis meses esto sigue igual, ¿qué pasa?",
      "method": "Challenger · Gap Selling · neuroventas"
    },
    {
      "id": "demo",
      "label": "Solución",
      "minutes": 10,
      "goal": "Mostrar solo lo que resuelve el dolor que el propio lead nombró.",
      "do": [
        "Conecta cada punto con algo que el lead dijo.",
        "Máximo tres beneficios y, después de cada uno, una pregunta.",
        "Usa un caso real parecido; si no tienes uno, usa su propio escenario."
      ],
      "say": "Me dijiste qué es lo que más les cuesta hoy. Te muestro solo cómo se resuelve eso y me dices si aplica a su caso.",
      "method": "Challenger: adapta el mensaje · neuroventas: menos es más"
    },
    {
      "id": "negotiation",
      "label": "Objeciones y negociación",
      "minutes": 8,
      "goal": "Resolver las dudas sin discutir y sin regalar valor.",
      "do": [
        "Nombra la emoción del lead antes de responder.",
        "Haz una pregunta abierta que lo ponga a resolver contigo.",
        "No bajes el precio: vuelve al costo de no resolverlo."
      ],
      "say": "Parece que hay algo que todavía no te termina de convencer. ¿Qué tendría que pasar para que esto tenga sentido para ustedes?",
      "method": "Chris Voss: etiquetar y preguntas calibradas"
    },
    {
      "id": "close",
      "label": "Cierre",
      "minutes": 5,
      "goal": "Salir con un siguiente paso con fecha y responsables.",
      "do": [
        "Resume lo acordado en una frase.",
        "Propón el siguiente paso con día y hora.",
        "Confirma quién más tiene que estar y qué necesita ver."
      ],
      "say": "Con lo que vimos, lo que sigue es dejar agendado el siguiente paso. ¿Qué día de esta semana te queda mejor para dejarlo en el calendario ahora mismo?",
      "method": "Sandler: sí o no claro, nunca «lo pienso» · MEDDIC: proceso de decisión"
    }
  ],
  "OBJECTIONS": [
    {
      "id": "precio",
      "title": "Objeción de precio",
      "patterns": [
        "\\bcar[oa]s?\\b",
        "costos[oa]",
        "no tenemos presupuesto",
        "sin presupuesto",
        "fuera de(l)? presupuesto",
        "no (nos )?alcanza",
        "descuento",
        "mas (barato|economico)",
        "mucho dinero",
        "mucha plata"
      ],
      "say": "Entiendo que el precio importa. Aparte del precio, ¿hay algo más que te frene? Y dime: ¿cuánto les está costando hoy no resolverlo?",
      "why": "No defiendas el precio: aísla la objeción y vuelve al costo de quedarse igual."
    },
    {
      "id": "timing",
      "title": "Objeción de tiempo",
      "patterns": [
        "no es (el|un buen|buen) momento",
        "mas adelante",
        "el proximo (ano|trimestre|mes|semestre)",
        "ahora no",
        "ahorita no",
        "por ahora no",
        "estamos (muy )?ocupad",
        "no tenemos tiempo",
        "despues lo vemos",
        "lo vemos despues"
      ],
      "say": "Tiene sentido, nadie quiere sumar otro proyecto ahora. ¿Qué cambia entre hoy y esa fecha? Te lo pregunto porque mientras tanto el problema sigue costando.",
      "why": "Valida y pregunta qué cambia con esperar: casi nunca cambia nada."
    },
    {
      "id": "autoridad",
      "title": "No decide solo",
      "patterns": [
        "tengo que (consultar|hablar|ver|revisar)",
        "lo tengo que (consultar|hablar|ver|revisar)",
        "consultarlo con",
        "no (lo )?decido yo",
        "no depende de mi",
        "no es mi decision",
        "mi (jefe|jefa|socio|socia|director|directora|gerente)",
        "el comite",
        "la junta"
      ],
      "say": "Perfecto, es una decisión que conviene tomar acompañado. ¿Qué va a necesitar ver esa persona para decir que sí? ¿Te parece si la sumamos a una llamada corta esta semana?",
      "why": "Averigua el proceso de decisión y consigue al decisor en el siguiente paso."
    },
    {
      "id": "competencia",
      "title": "Ya tiene otra solución",
      "patterns": [
        "ya tenemos (un |una )?(proveedor|herramienta|solucion|sistema|agencia|plataforma)",
        "ya trabajamos con",
        "ya usamos",
        "estamos con otr",
        "ya lo hacemos (internamente|nosotros|en casa)",
        "lo hacemos internamente"
      ],
      "say": "Qué bueno que ya lo tienen cubierto. ¿Qué es lo que más valoras de cómo lo hacen hoy? Y si pudieras mejorar una sola cosa, ¿cuál sería?",
      "why": "Nunca ataques a su proveedor: busca la brecha entre lo que tiene y lo que quiere."
    },
    {
      "id": "info",
      "title": "«Mándame información»",
      "patterns": [
        "(mandame|enviame|pasame|mandanos|envianos) (la |mas |algo de |un poco de )?(info|informacion)",
        "(mandame|enviame) un (correo|mail|email)",
        "(mandame|enviame|pasame) (una |la |tu )?(propuesta|presentacion|cotizacion)"
      ],
      "say": "Claro, te la envío. Para mandarte solo lo que te sirve: ¿qué necesitarías ver ahí para que valga la pena seguir conversando?",
      "why": "Suele ser una salida amable: acepta y pregunta qué debe traer para que avance."
    },
    {
      "id": "necesidad",
      "title": "No ve la necesidad",
      "patterns": [
        "no (lo |la |los |las )?necesitamos",
        "no nos interesa",
        "no me interesa",
        "no le veo",
        "estamos bien asi",
        "no es (una )?prioridad",
        "no nos hace falta"
      ],
      "say": "Te entiendo, y no quiero insistir si no aplica. Solo para cerrar bien: ¿cómo están resolviendo hoy ese tema y qué tan conformes están con el resultado?",
      "why": "Sin dolor no hay venta: vuelve a descubrir antes de presentar nada."
    },
    {
      "id": "confianza",
      "title": "Duda de que funcione",
      "patterns": [
        "no (los |las )?conozco",
        "quien mas (lo |la )?usa",
        "tienen (casos|clientes|referencias)",
        "como se que funciona",
        "que garantia",
        "y si no funciona"
      ],
      "say": "Es justo que lo preguntes. ¿Qué necesitarías ver para estar tranquilo de que funciona en un caso como el tuyo?",
      "why": "Pregunta qué prueba necesita y usa solo casos reales; nunca inventes uno."
    }
  ],
  "METHODS": [
    {
      "name": "SPIN Selling (Neil Rackham)",
      "rule": "Pregunta en orden: situación, problema, implicación y, al final, qué ganaría si lo resuelve. El lead tiene que decir el beneficio, no tú."
    },
    {
      "name": "The Challenger Sale",
      "rule": "Enseña algo que el lead no sabía de su propio problema, adapta el mensaje a quien tienes enfrente y toma el control del siguiente paso."
    },
    {
      "name": "Sandler",
      "rule": "Contrato inicial al abrir (agenda, tiempo y decisión al final), embudo del dolor (superficie, impacto en el negocio, impacto personal) y un sí o un no claro: nunca aceptes «lo pienso» sin fecha."
    },
    {
      "name": "Gap Selling (Keenan)",
      "rule": "Vende la brecha entre el estado actual y el estado futuro que quiere el lead; sin brecha medida no hay urgencia."
    },
    {
      "name": "MEDDIC",
      "rule": "Antes de cerrar hay que saber: la métrica que mejora, quién firma, con qué criterios deciden, cómo es el proceso de decisión, cuál es el dolor y quién es tu aliado interno."
    },
    {
      "name": "Never Split the Difference (Chris Voss)",
      "rule": "Etiqueta la emoción («parece que…»), repite sus últimas palabras para que siga hablando y usa preguntas que empiezan con «qué» o «cómo»; un «no» es el inicio de la negociación."
    },
    {
      "name": "Influence (Robert Cialdini)",
      "rule": "Prueba social solo con casos reales, reciprocidad (da algo útil primero) y compromiso: consigue acuerdos pequeños antes del grande."
    }
  ]
};

export const STAGES = DATA.STAGES;
export const OBJECTIONS = DATA.OBJECTIONS;
export const METHODS = DATA.METHODS;

export function normalize(text: unknown): string {
  return String(text == null ? '' : text).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const COMPILED = DATA.OBJECTIONS.map(function (o) {
  return { o: o, res: o.patterns.map(function (p) { return new RegExp(p); }) };
});
/** Objeción que el lead acaba de verbalizar, o null. Determinista y sin IA. */
export function detectObjection(text: unknown): { id: string; title: string; say: string; why: string } | null {
  const t = normalize(text);
  if (t.length < 6) return null;
  for (let i = 0; i < COMPILED.length; i++) {
    for (let j = 0; j < COMPILED[i].res.length; j++) {
      if (COMPILED[i].res[j].test(t)) {
        const o = COMPILED[i].o;
        return { id: o.id, title: o.title, say: o.say, why: o.why };
      }
    }
  }
  return null;
}
export function stage(id: string): Stage | null {
  for (let i = 0; i < DATA.STAGES.length; i++) if (DATA.STAGES[i].id === id) return DATA.STAGES[i];
  return null;
}
export function stageLabel(id: string): string { const s = stage(id); return s ? s.label : ''; }
export function nextStage(id: string): Stage | null {
  for (let i = 0; i < DATA.STAGES.length - 1; i++) if (DATA.STAGES[i].id === id) return DATA.STAGES[i + 1];
  return null;
}
/** Minuto (desde el inicio) en que la fase debería haber terminado. */
export function stageDeadline(id: string): number {
  let total = 0;
  for (let i = 0; i < DATA.STAGES.length; i++) {
    total += DATA.STAGES[i].minutes;
    if (DATA.STAGES[i].id === id) return total;
  }
  return total;
}

/** Doctrina por fase para los prompts del coach (en vivo y reporte). */
export function playbookDoctrine(): string {
  const lines: string[] = [
    "PLAYBOOK POR FASE (mejores prácticas de los libros de venta; aplícalas SIEMPRE, sin nombrar el libro al vendedor):",
    "Desde el primer segundo sabes en qué fase está la llamada y qué toca decir. Si la conversación aún no",
    "empezó o solo hay saludos, la fase es \"rapport\" y tu orden es abrir con la agenda.",
  ];
  for (const s of DATA.STAGES) {
    lines.push(`- ${s.id} (${s.label}, ~${s.minutes} min) — ${s.goal} Qué hacer: ${s.do.join(" ")} [${s.method}]`);
  }
  lines.push(
    "No se avanza de fase sin cumplir el objetivo de la anterior: sin dolor dicho por el lead no hay solución;",
    "sin siguiente paso con fecha no hay cierre. Si el vendedor se salta una fase, ordénale volver.",
    "",
    "REGLAS DE LOS LIBROS (úsalas para elegir la frase exacta):",
  );
  for (const m of DATA.METHODS) lines.push(`- ${m.name}: ${m.rule}`);
  return lines.join("\n");
}
