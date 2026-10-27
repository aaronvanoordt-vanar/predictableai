/**
 * scripts/registry-import/map.mjs — fuentes y mapeo de los registros de
 * empresas que solo se publican como archivo (2026-10-27).
 *
 * Parte PURA del importador (sin red ni disco): qué archivos tiene cada
 * fuente, cómo se leen sus columnas y cómo una fila se vuelve una fila de
 * `registry_companies`. La red y la carga viven en import.mjs. Lo prueba
 * supabase/functions/_shared/registry-import.test.ts (Deno), que además
 * verifica que `normCompanyName` dé lo mismo que el de _shared/registries.ts:
 * la búsqueda por razón social compara contra `name_norm`.
 *
 * Las columnas de cada archivo NO se pudieron ver desde la sesión que
 * escribió esto (el proxy bloquea los portales oficiales): cada campo se
 * busca por varios nombres posibles en el encabezado real, y el importador
 * se detiene mostrando el encabezado si falta un campo obligatorio. Nunca se
 * inventa un dato: lo que el archivo no trae queda vacío.
 * Fuentes y licencias en docs/REGISTROS.md.
 */

// ── texto ───────────────────────────────────────────────────────────────────

export function stripAccents(t) {
  return String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const clean = (v, max = 300) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Encabezado comparable: "Razón Social" → "razon_social". */
export function normHeader(h) {
  return stripAccents(h).toLowerCase().replace(/^﻿/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Misma lista y mismo algoritmo que normCompanyName de supabase/functions/_shared/registries.ts.
const LEGAL_SUFFIXES = [
  "s a b de c v", "s a p i de c v", "s de r l de c v", "s a de c v", "sa de cv", "sapi de cv", "s de rl de cv", "s c", "a c",
  "s a s", "sas", "s a", "sa", "ltda", "limitada", "eireli", "epp", "me", "mei", "cia", "compania", "companhia", "e hijos", "y cia",
  "s en c", "srl", "s r l", "inc", "llc", "corp", "corporation", "group", "grupo",
];

export function normCompanyName(v) {
  let t = " " + stripAccents(clean(v)).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim() + " ";
  for (let pass = 0; pass < 3; pass++) {
    for (const suf of LEGAL_SUFFIXES) t = t.replace(new RegExp(` ${suf} $`), " ");
  }
  return t.trim();
}

export function digits(v) {
  return String(v ?? "").replace(/\D+/g, "");
}

/** "2024-03-05", "2024-03-05 10:00", "20240305", "05/03/2024", "5-3-2024" → "2024-03-05". Fechas imposibles o de relleno (1900/1901) → "". */
export function isoDate(v) {
  const t = clean(v, 40);
  let y, m, d, x;
  if ((x = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [, y, m, d] = x;
  else if ((x = t.match(/^(\d{4})(\d{2})(\d{2})$/))) [, y, m, d] = x;
  else if ((x = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/))) [, d, m, y] = x;
  else return "";
  const Y = Number(y), M = Number(m), D = Number(d);
  if (Y < 1902 || Y > 2100 || M < 1 || M > 12 || D < 1 || D > 31) return "";
  return `${Y}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
}

/** Código de actividad al inicio de un texto: "620100 - Servicios…" → { code: "620100", description: "Servicios…" }. */
export function splitActivity(v) {
  const t = clean(v);
  const m = t.match(/^([A-Z]?\s?\d[\d.]{1,9})\s*[-–:]?\s*(.*)$/);
  if (m) return { code: digits(m[1]), description: clean(m[2]) };
  return { code: "", description: t };
}

/** Teléfono con su prefijo de país, o "" si no parece un número. */
export function phoneWith(cc, v) {
  const t = String(v ?? "").split(/[\/;,]| y /)[0].replace(/[^\d+]/g, "");
  if (t.replace(/\D/g, "").length < 7) return "";
  return t.startsWith("+") ? t : `+${cc} ${t.replace(/^0+/, "")}`;
}

export function emailOf(v) {
  const t = clean(v, 200).toLowerCase().split(/[\s;,]/)[0];
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(t) ? t : "";
}

export function websiteOf(v) {
  const t = clean(v, 200).toLowerCase();
  return /^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/.test(t) ? t : "";
}

// ── lectura de filas ────────────────────────────────────────────────────────

/** Separador del archivo según el encabezado (o la primera fila). */
export function detectDelimiter(line) {
  const counts = ["\t", "|", ";", ","].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/**
 * Parser de CSV por trozos: comillas dobles, separadores dentro de comillas
 * y saltos de línea dentro de comillas. `push(texto)` y al final `end()`;
 * cada fila completa llega a `onRow(campos[])`.
 */
export function createRowParser(delimiter, onRow, opts = {}) {
  const quotes = opts.quotes !== false;
  let field = "", row = [], inQ = false, pendingQuote = false;
  function endRow() {
    row.push(field); field = "";
    if (!(row.length === 1 && row[0] === "")) onRow(row);
    row = [];
  }
  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') { field += '"'; continue; }
          inQ = false;
        }
        if (inQ) {
          if (ch === '"') pendingQuote = true; else field += ch;
          continue;
        }
        if (quotes && ch === '"' && field === "") { inQ = true; continue; }
        if (ch === delimiter) { row.push(field); field = ""; continue; }
        if (ch === "\n") { endRow(); continue; }
        if (ch === "\r") continue;
        field += ch;
      }
    },
    end() {
      if (field !== "" || row.length) endRow();
    },
  };
}

/** Índice de cada campo del mapa en el encabezado, por el primer alias que exista. */
export function resolveColumns(header, fields) {
  const norm = header.map(normHeader);
  const out = {};
  for (const [key, aliases] of Object.entries(fields)) {
    out[key] = -1;
    for (const a of aliases) {
      const i = norm.indexOf(normHeader(a));
      if (i >= 0) { out[key] = i; break; }
    }
    if (out[key] < 0) {
      // Prefijo: "fecha_inicio_actividades_vigente" calza con el alias "fecha_inicio_actividades".
      for (const a of aliases) {
        const na = normHeader(a);
        const i = norm.findIndex((h) => na.length >= 4 && h.startsWith(na));
        if (i >= 0) { out[key] = i; break; }
      }
    }
  }
  return out;
}

/** ¿La primera fila es encabezado? Sí si alguno de sus campos calza con un alias del mapa. */
export function looksLikeHeader(cells, fields) {
  const norm = new Set(cells.map(normHeader));
  return Object.values(fields).some((aliases) => aliases.some((a) => norm.has(normHeader(a))));
}

export function rowObject(cells, cols) {
  const o = {};
  for (const [k, i] of Object.entries(cols)) o[k] = i >= 0 ? clean(cells[i], 400) : "";
  return o;
}

// ── catálogos ───────────────────────────────────────────────────────────────

// Departamentos del Perú por los dos primeros dígitos del ubigeo (INEI).
export const PE_DEPARTMENTS = {
  "01": "Amazonas", "02": "Áncash", "03": "Apurímac", "04": "Arequipa", "05": "Ayacucho", "06": "Cajamarca", "07": "Callao",
  "08": "Cusco", "09": "Huancavelica", "10": "Huánuco", "11": "Ica", "12": "Junín", "13": "La Libertad", "14": "Lambayeque",
  "15": "Lima", "16": "Loreto", "17": "Madre de Dios", "18": "Moquegua", "19": "Pasco", "20": "Piura", "21": "Puno",
  "22": "San Martín", "23": "Tacna", "24": "Tumbes", "25": "Ucayali",
};

/** Tramo de ventas del SII (1–13) → tamaño. 2–4 micro, 5–7 pequeña, 8–9 mediana, 10–13 grande; 1 = sin ventas. */
export function siiSizeBucket(tramo) {
  const n = Number(digits(tramo));
  if (!n || n === 1) return "";
  if (n <= 4) return "micro";
  if (n <= 7) return "small";
  if (n <= 9) return "medium";
  return "large";
}

const SIZE_LABEL = { micro: "Micro (≤ 10 personas)", small: "Pequeña (11–50)", medium: "Mediana (51–250)", large: "Grande (251+)" };

// ── fuentes ─────────────────────────────────────────────────────────────────
//
// discover:
//   { type: "ckan", base, package }          package_show → recursos
//   { type: "ckan_search", base, q }         package_search → recursos de los paquetes que calzan
//   { type: "page", url, link }              enlaces de una página pública (sin captcha) que calzan con `link`
//   { type: "fixed", urls }                  URLs fijas
// pick: RegExp sobre nombre/URL del recurso para quedarse con los archivos de datos.
// fields: campo → alias posibles del encabezado. required: campos sin los que el archivo no sirve.
// columns: para archivos SIN encabezado, el nombre de cada posición (el mapa `fields` se aplica sobre esos nombres).
// map(row, ctx) → fila de registry_companies (sin registry/country/name_norm, que agrega el importador) o null.

export const SOURCES = {
  rns: {
    registry: "rns", country: "Argentina", activity_system: "isic4",
    title: "Registro Nacional de Sociedades (ARCA, datos.jus.gob.ar)",
    discover: { type: "ckan", base: "https://datos.jus.gob.ar", package: "registro-nacional-de-sociedades" },
    pick: /\.(zip|csv)(\?|$)/i, skip: /muestr/i,
    fields: {
      cuit: ["cuit"], name: ["razon_social"], founded: ["fecha_hora_contrato_social", "fecha_contrato_social"],
      type: ["tipo_societario"], code: ["actividad_codigo", "codigo_actividad"], activity: ["actividad_descripcion", "descripcion_actividad"],
      order: ["actividad_orden"], province: ["dom_fiscal_provincia", "dom_legal_provincia"], city: ["dom_fiscal_localidad", "dom_legal_localidad"],
      street: ["dom_fiscal_calle", "dom_legal_calle"], number: ["dom_fiscal_numero", "dom_legal_numero"], cp: ["dom_fiscal_cp", "dom_legal_cp", "dom_fiscal_codigo_postal"],
      baja: ["fecha_hora_baja", "fecha_baja"],
    },
    required: ["cuit", "name"],
    map(r) {
      const cuit = digits(r.cuit);
      if (cuit.length !== 11) return null;
      // Una fila por actividad: la principal es la de orden 1 (o la única).
      if (r.order && digits(r.order) !== "1") return null;
      const act = r.code ? { code: digits(r.code), description: r.activity } : splitActivity(r.activity);
      return {
        registry_id: cuit, tax_id: cuit, legal_name: r.name,
        activity_code: act.code, activity_description: act.description,
        founded_on: isoDate(r.founded), founded_label: "Contrato social",
        status: isoDate(r.baja) ? "inactive" : "unknown", status_detail: r.type,
        address_line: [r.street, r.number].filter(Boolean).join(" "), city: r.city, region: r.province, postal_code: r.cp,
        source_url: "https://datos.jus.gob.ar/dataset/registro-nacional-de-sociedades",
      };
    },
  },

  sii: {
    registry: "sii", country: "Chile", activity_system: "isic4",
    title: "Nómina de personas jurídicas (SII)",
    discover: { type: "page", url: "https://www.sii.cl/sobre_el_sii/nominapersonasjuridicas.html", link: /\.(zip|txt|csv)(\?|$)/i },
    pick: /nomina|pjur|persona|juridic|pub_/i,
    fields: {
      year: ["ano_comercial", "anio_comercial", "ano"], rut: ["rut"], dv: ["dv", "digito_verificador"], name: ["razon_social", "nombre_razon_social"],
      tramo: ["tramo_segun_ventas", "tramo_ventas", "tramo_de_ventas"], workers: ["numero_de_trabajadores_dependientes_informados", "numero_trabajadores", "trabajadores"],
      start: ["fecha_inicio_de_actividades_vigente", "fecha_inicio_actividades_vigente", "fecha_inicio_actividades", "fecha_inicio_de_actividades"],
      end: ["fecha_termino_de_giro", "fecha_termino_giro"], kind: ["tipo_de_contribuyente", "tipo_contribuyente"],
      region: ["region"], comuna: ["comuna"], activity: ["actividad_economica", "actividad_economica_principal", "subrubro_economico", "rubro_economico", "rubro"],
    },
    required: ["rut", "name"],
    map(r, ctx) {
      const rut = digits(r.rut);
      if (!rut) return null;
      const id = rut + String(r.dv || "").toUpperCase().replace(/[^0-9K]/g, "");
      // El archivo trae un año comercial por fila: queda el más reciente de cada RUT.
      const year = Number(digits(r.year)) || 0;
      if (ctx.seen) {
        const prev = ctx.seen.get(id) || 0;
        if (year && year < prev) return null;
        if (year) ctx.seen.set(id, year);
      }
      const act = splitActivity(r.activity);
      const bucket = siiSizeBucket(r.tramo);
      return {
        registry_id: id, tax_id: id, legal_name: r.name,
        activity_code: act.code, activity_description: act.description,
        size_bucket: bucket, size_label: bucket ? `${SIZE_LABEL[bucket]} · tramo de ventas ${digits(r.tramo)} del SII` : "",
        founded_on: isoDate(r.start), founded_label: "Inicio de actividades",
        status: isoDate(r.end) ? "inactive" : "active", status_detail: isoDate(r.end) ? `Término de giro ${isoDate(r.end)}` : (year ? `Año comercial ${year}` : ""),
        city: r.comuna, region: r.region,
        source_url: "https://www.sii.cl/sobre_el_sii/nominapersonasjuridicas.html",
      };
    },
  },

  sii_res: {
    registry: "sii", country: "Chile", activity_system: "isic4",
    title: "Registro de Empresas y Sociedades (datos.gob.cl)",
    discover: { type: "ckan", base: "https://datos.gob.cl", package: "registro-de-empresas-y-sociedades" },
    pick: /\.csv(\?|$)/i,
    fields: {
      rut: ["rut", "rut_empresa", "rut_sociedad"], name: ["razon_social", "nombre_razon_social", "razon"],
      date: ["fecha_de_constitucion", "fecha_constitucion", "fecha_de_actuacion", "fecha"], comuna: ["comuna_tributaria", "comuna"],
      region: ["region_tributaria", "region"], type: ["tipo_de_actuacion", "tipo_actuacion"], kind: ["codigo_de_sociedad", "tipo_sociedad", "tipo_de_sociedad"],
    },
    required: ["rut", "name"],
    map(r) {
      const raw = String(r.rut || "").toUpperCase().replace(/[^0-9K]/g, "");
      if (raw.length < 7) return null;
      // Solo constituciones: las modificaciones y disoluciones no cambian la fecha de nacimiento.
      if (r.type && !/CONSTITU/i.test(stripAccents(r.type))) return null;
      return {
        registry_id: raw, tax_id: raw, legal_name: r.name,
        founded_on: isoDate(r.date), founded_label: "Constitución (Registro de Empresas y Sociedades)",
        status_detail: r.kind, city: r.comuna, region: r.region,
        source_url: "https://datos.gob.cl/dataset/registro-de-empresas-y-sociedades",
      };
    },
  },

  sunat: {
    registry: "sunat", country: "Peru", activity_system: "local",
    title: "Padrón reducido del RUC (SUNAT)",
    discover: { type: "fixed", urls: ["https://www.sunat.gob.pe/descargaPRR/padron_reducido_ruc.zip"] },
    pick: /\.(zip|txt)(\?|$)/i,
    fields: {
      ruc: ["ruc"], name: ["nombre_o_razon_social", "razon_social", "nombre"], status: ["estado_del_contribuyente", "estado"],
      cond: ["condicion_de_domicilio", "condicion"], ubigeo: ["ubigeo"], via_t: ["tipo_de_via"], via: ["nombre_de_via"], num: ["numero"],
    },
    columns: ["ruc", "nombre_o_razon_social", "estado_del_contribuyente", "condicion_de_domicilio", "ubigeo", "tipo_de_via", "nombre_de_via", "codigo_de_zona", "tipo_de_zona", "numero", "interior", "lote", "departamento", "manzana", "kilometro"],
    required: ["ruc", "name"],
    map(r) {
      const ruc = digits(r.ruc);
      if (ruc.length !== 11 || !ruc.startsWith("20")) return null; // 20… = persona jurídica
      const st = stripAccents(r.status).toUpperCase();
      const dash = (v) => (v && v !== "-" ? v : "");
      return {
        registry_id: ruc, tax_id: ruc, legal_name: r.name,
        status: /^ACTIVO/.test(st) ? "active" : st ? "inactive" : "unknown",
        status_detail: [r.status, dash(r.cond) ? `domicilio ${r.cond.toLowerCase()}` : ""].filter(Boolean).join(" · "),
        address_line: [dash(r.via_t), dash(r.via), dash(r.num)].filter(Boolean).join(" "),
        region: PE_DEPARTMENTS[digits(r.ubigeo).slice(0, 2)] || "",
        source_url: "https://www.sunat.gob.pe/descargaPRR/mrc137_padron_reducido.html",
      };
    },
  },

  sri: {
    registry: "sri", country: "Ecuador", activity_system: "isic4",
    title: "Catastro RUC del SRI (datosabiertos.gob.ec)",
    discover: { type: "ckan_search", base: "https://www.datosabiertos.gob.ec", q: "registro unico de contribuyentes SRI" },
    pick: /\.(zip|csv|txt)(\?|$)/i, skip: /dicc|_dd|diccionario/i,
    fields: {
      ruc: ["numero_ruc", "ruc"], name: ["razon_social"], trade: ["nombre_comercial", "nombre_fantasia_comercial"],
      status: ["estado_contribuyente", "estado"], kind: ["tipo_contribuyente", "clase_contribuyente"], start: ["fecha_inicio_actividades"],
      suspended: ["fecha_suspension_definitiva"], estab: ["numero_establecimiento"], province: ["descripcion_provincia_est", "descripcion_provincia", "provincia"],
      canton: ["descripcion_canton_est", "descripcion_canton", "canton"], code: ["codigo_ciiu", "ciiu"], activity: ["actividad_economica"],
    },
    required: ["ruc", "name"],
    map(r) {
      const ruc = digits(r.ruc);
      if (ruc.length !== 13) return null;
      // Sociedades: tercer dígito 9 (privadas) o 6 (públicas); 0–5 son personas naturales.
      if (!/^\d\d[69]/.test(ruc) && !/SOCIEDAD/i.test(r.kind)) return null;
      if (r.estab && digits(r.estab) && Number(digits(r.estab)) !== 1) return null; // solo la matriz
      const st = stripAccents(r.status).toUpperCase();
      return {
        registry_id: ruc, tax_id: ruc, legal_name: r.name, trade_name: r.trade,
        activity_code: digits(r.code), activity_description: r.activity,
        founded_on: isoDate(r.start), founded_label: "Inicio de actividades",
        status: /^ACTIV/.test(st) ? "active" : st ? "inactive" : "unknown", status_detail: r.status,
        city: r.canton, region: r.province,
        source_url: "https://www.sri.gob.ec/datasets",
      };
    },
  },

  dgii: {
    registry: "dgii", country: "Dominican Republic", activity_system: "local",
    title: "Listado de RNC (DGII)",
    discover: { type: "fixed", urls: ["https://dgii.gov.do/app/WebApps/Consultas/RNC/DGII_RNC.zip"] },
    pick: /\.(zip|txt)(\?|$)/i,
    fields: {
      rnc: ["rnc", "rnc_cedula"], name: ["razon_social", "nombre_razon_social"], trade: ["nombre_comercial"], activity: ["actividad_economica", "actividad"],
      date: ["fecha_constitucion", "fecha_de_constitucion", "fecha_inicio_operaciones", "fecha"], status: ["estado"], regime: ["regimen_de_pagos", "regimen_pago", "regimen"],
    },
    // Sin encabezado: RNC|razón social|nombre comercial|actividad|…|fecha|estado|régimen (posiciones reportadas, sin confirmar;
    // la fecha y el estado se ubican también por forma, ver map).
    columns: ["rnc", "razon_social", "nombre_comercial", "actividad_economica", "c5", "c6", "c7", "c8", "fecha", "estado", "regimen"],
    required: ["rnc", "name"],
    map(r, ctx) {
      const rnc = digits(r.rnc);
      if (rnc.length !== 9) return null; // 9 dígitos = empresa; 11 = cédula de una persona
      // Las posiciones no están confirmadas: la fecha y el estado se ubican por su forma.
      const cells = ctx.cells || [];
      const statusRe = /^(ACTIVO|SUSPENDIDO|DADO DE BAJA|CESE|INACTIVO|ANULADO|RECHAZADO|BAJA)/i;
      const date = cells.map(isoDate).find(Boolean) || isoDate(r.date);
      const status = cells.find((c) => statusRe.test(String(c).trim())) || (statusRe.test(r.status) ? r.status : "");
      const act = splitActivity(r.activity);
      return {
        registry_id: rnc, tax_id: rnc, legal_name: r.name, trade_name: r.trade,
        activity_code: act.code, activity_description: act.description,
        founded_on: date, founded_label: "Inicio de operaciones",
        status: /^ACTIVO/i.test(status) ? "active" : status ? "inactive" : "unknown", status_detail: [status, r.regime].filter(Boolean).join(" · "),
        source_url: "https://dgii.gov.do/herramientas/consultas/Paginas/RNC.aspx",
      };
    },
  },

  rmgt: {
    registry: "rmgt", country: "Guatemala", activity_system: "local",
    title: "Sociedades inscritas en el Registro Mercantil (MINECO)",
    discover: { type: "ckan_search", base: "https://catalogo.senacyt.gob.gt", q: "sociedades inscritas registro mercantil" },
    pick: /\.csv(\?|$)/i,
    fields: {
      nit: ["nit"], reg: ["numero_de_registro", "registro", "no_registro", "expediente", "numero_registro"],
      name: ["nombre_de_la_sociedad", "nombre_sociedad", "razon_social", "denominacion", "nombre"],
      trade: ["nombre_comercial"], date: ["fecha_de_inscripcion", "fecha_inscripcion", "fecha"], type: ["tipo_de_sociedad", "tipo_sociedad", "tipo"],
      activity: ["actividad", "actividad_economica", "objeto"], dept: ["departamento"], muni: ["municipio"],
    },
    required: ["name"],
    map(r) {
      const nit = String(r.nit || "").toUpperCase().replace(/[^0-9K]/g, "");
      const reg = digits(r.reg);
      const id = nit || (reg ? `reg-${reg}` : "");
      if (!id) return null;
      return {
        registry_id: id, tax_id: nit, legal_name: r.name, trade_name: r.trade,
        activity_description: r.activity, founded_on: isoDate(r.date), founded_label: "Inscripción en el Registro Mercantil",
        status_detail: r.type, city: r.muni, region: r.dept,
        source_url: "https://catalogo.senacyt.gob.gt/dataset/sociedades-inscritas-en-registro-mercantil",
      };
    },
  },

  dei: {
    registry: "dei", country: "Uruguay", activity_system: "isic4",
    title: "Directorio de Empresas Industriales (MIEM)",
    discover: { type: "ckan", base: "https://catalogodatos.gub.uy", package: "miem-dei" },
    pick: /\.csv(\?|$)/i, latestOnly: true,
    fields: {
      rut: ["rut"], name: ["razon_social"], trade: ["nombre_fantasia", "nombre_de_fantasia"], status: ["estado"],
      code: ["ciiu", "codigo_ciiu", "ciiu_principal", "cod_ciiu"], activity: ["descripcion_ciiu", "ciiu_descripcion", "actividad", "descripcion"],
      address: ["direccion", "domicilio"], city: ["localidad", "ciudad"], dept: ["departamento"], phone: ["telefono", "telefonos"],
      email: ["correo_electronico", "email", "correo", "mail"], web: ["pagina_web", "sitio_web", "web"],
    },
    required: ["rut", "name"],
    map(r) {
      const rut = digits(r.rut);
      if (rut.length < 9) return null;
      const st = stripAccents(r.status).toUpperCase();
      return {
        registry_id: rut, tax_id: rut, legal_name: r.name, trade_name: r.trade,
        activity_code: digits(r.code), activity_description: r.activity,
        status: /VIGENTE/.test(st) ? "active" : /VENCID/.test(st) ? "inactive" : "unknown", status_detail: r.status ? `Registro industrial ${r.status.toLowerCase()}` : "",
        address_line: r.address, city: r.city, region: r.dept,
        phone: phoneWith("598", r.phone), email: emailOf(r.email), website: websiteOf(r.web),
        source_url: "https://catalogodatos.gub.uy/dataset/miem-dei",
      };
    },
  },

  dnit: {
    registry: "dnit", country: "Paraguay", activity_system: "local",
    title: "Listado de RUC (DNIT)",
    discover: { type: "page", url: "https://www.dnit.gov.py/web/portal-institucional/listado-de-ruc-con-sus-equivalencias", link: /ruc\d\.zip/i },
    pick: /\.(zip|txt)(\?|$)/i,
    fields: { ruc: ["ruc"], name: ["nombre", "razon_social"], dv: ["dv"], status: ["estado"] },
    columns: ["ruc", "nombre", "dv", "codigo_viejo", "estado"],
    required: ["ruc", "name"],
    map(r) {
      const ruc = digits(r.ruc);
      if (!ruc.startsWith("80") || ruc.length < 7) return null; // 80… = persona jurídica
      const id = ruc + digits(r.dv);
      const st = stripAccents(r.status).toUpperCase();
      return {
        registry_id: id, tax_id: id, legal_name: r.name,
        status: /^ACTIVO/.test(st) ? "active" : st ? "inactive" : "unknown", status_detail: r.status,
        source_url: "https://www.dnit.gov.py/web/portal-institucional/listado-de-ruc-con-sus-equivalencias",
      };
    },
  },
};

/** Fuentes que alimentan cada registro (Chile tiene dos). */
export function sourcesFor(registry) {
  return Object.entries(SOURCES).filter(([, s]) => s.registry === registry).map(([key]) => key);
}

/** Fila del mapa → fila completa de registry_companies, o null. */
export function finishRow(source, mapped, sourceUpdatedOn = "") {
  if (!mapped || !clean(mapped.legal_name) || !clean(mapped.registry_id)) return null;
  const s = SOURCES[source];
  const out = {
    registry: s.registry, country: s.country, activity_system: s.activity_system,
    registry_id: clean(mapped.registry_id, 60), tax_id: clean(mapped.tax_id || "", 30),
    legal_name: clean(mapped.legal_name), trade_name: clean(mapped.trade_name || ""),
    name_norm: [normCompanyName(mapped.legal_name), normCompanyName(mapped.trade_name || "")].filter(Boolean).join(" "),
    activity_code: digits(mapped.activity_code).replace(/^0+$/, "").slice(0, 12), activity_description: clean(mapped.activity_description || ""),
    size_bucket: mapped.size_bucket || "", size_label: clean(mapped.size_label || ""),
    founded_on: mapped.founded_on || "", founded_label: mapped.founded_on ? clean(mapped.founded_label || "") : "",
    status: mapped.status || "unknown", status_detail: clean(mapped.status_detail || ""),
    address_line: clean(mapped.address_line || ""), city: clean(mapped.city || "", 120), region: clean(mapped.region || "", 120),
    postal_code: clean(mapped.postal_code || "", 20), phone: clean(mapped.phone || "", 40), email: clean(mapped.email || "", 200),
    website: clean(mapped.website || "", 200), source_url: clean(mapped.source_url || "", 300), source_updated_on: sourceUpdatedOn || "",
  };
  return out;
}
