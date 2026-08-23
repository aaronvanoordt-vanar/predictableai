/**
 * parseLlmJson — lee el JSON que devuelve un modelo, aguantando lo que los
 * modelos hacen de verdad.
 *
 * Cada edge function con IA traía su propia copia de un parser de tres líneas:
 * quitar las comillas de markdown, `JSON.parse`, y si fallaba, buscar el primer
 * `{` y contar llaves hasta que cuadraran. Ese contador tiene dos agujeros que
 * en producción tumban la corrida entera:
 *
 *  1. No sabe de strings. Una llave dentro de un texto ("el activo {sic}") le
 *     descuadra la cuenta y recorta el JSON por un `}` que no cerraba nada.
 *  2. No sabe de truncamiento. Si la respuesta se corta a mitad de un array
 *     —porque el modelo llegó al tope de tokens— no hay cierre que encontrar,
 *     y lo único que queda es la excepción.
 *
 * Un brief entero se perdía por cualquiera de las dos, aunque el 95% del JSON
 * hubiera llegado bien. Aquí el escaneo respeta strings y escapes, y cuando la
 * respuesta viene cortada se repara: se retrocede al último punto donde el JSON
 * seguía siendo válido y se cierran los contenedores abiertos. Se prueba
 * `JSON.parse` en cada candidato de atrás hacia adelante, así que nunca se
 * devuelve algo que no parsee — como mucho, un objeto con los últimos campos de
 * menos, que es infinitamente mejor que perder la corrida completa.
 */

/** Cuántos puntos de corte se prueban al reparar. Acota el trabajo en una
 *  respuesta larga sin sacrificar nada realista: el corte bueno siempre está
 *  cerca del final. */
const MAX_REPAIR_ATTEMPTS = 300;

interface ScanResult {
  /** Índice del `}` que cierra el objeto raíz, o -1 si nunca cerró. */
  balancedEnd: number;
  /** Puntos donde el JSON todavía era válido, en orden. */
  cuts: { index: number; closers: string[] }[];
}

/** Recorre el texto respetando strings y escapes. */
function scan(text: string): ScanResult {
  const stack: string[] = [];
  const cuts: { index: number; closers: string[] }[] = [];
  let inString = false;
  let escaped = false;
  let balancedEnd = -1;

  const mark = (index: number) => {
    // Se guarda la pila invertida: es exactamente lo que habría que escribir
    // para cerrar lo que quedó abierto en este punto.
    cuts.push({ index, closers: stack.slice().reverse() });
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = false; mark(i + 1); }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") { stack.push(ch === "{" ? "}" : "]"); continue; }
    if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) stack.pop();
      mark(i + 1);
      if (stack.length === 0 && balancedEnd === -1) { balancedEnd = i; break; }
      continue;
    }
    // Cortar justo ANTES de una coma deja el elemento anterior completo.
    if (ch === ",") mark(i);
  }

  return { balancedEnd, cuts };
}

/** Cierra lo que quedó abierto en un punto de corte y limpia la cola. */
function closeAt(text: string, cut: { index: number; closers: string[] }): string {
  let head = text.slice(0, cut.index).replace(/[\s,]+$/, "");
  // Un `"clave":` colgando (la respuesta se cortó entre la clave y su valor)
  // no se puede cerrar: se quita junto con su coma.
  head = head.replace(/,?\s*"[^"]*"\s*:\s*$/, "");
  return head + cut.closers.join("");
}

export function parseLlmJson(raw: string): unknown {
  const cleaned = String(raw ?? "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  if (!cleaned) throw new Error("Empty response from model");

  // Camino feliz: la respuesta es JSON y ya.
  try { return JSON.parse(cleaned); } catch { /* sigue */ }

  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("No JSON found in response");
  const body = cleaned.slice(start);

  const { balancedEnd, cuts } = scan(body);

  // El objeto cerró: puede venir con prosa detrás, que es lo más común.
  if (balancedEnd !== -1) {
    try { return JSON.parse(body.slice(0, balancedEnd + 1)); } catch { /* sigue a reparar */ }
  }

  // Vino cortado (o el cierre encontrado no parsea): se retrocede al último
  // punto bueno y se cierra ahí. De atrás hacia adelante, para conservar todo
  // lo que sí llegó.
  const attempts = cuts.slice(-MAX_REPAIR_ATTEMPTS);
  for (let i = attempts.length - 1; i >= 0; i--) {
    const candidate = closeAt(body, attempts[i]);
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* siguiente candidato */ }
  }

  throw new Error("Unparseable JSON in response");
}
