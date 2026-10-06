/**
 * Notas de voz de la bandeja: WebM/Opus → Ogg/Opus, sin recodificar.
 *
 * Chrome y Edge graban con MediaRecorder SOLO en `audio/webm;codecs=opus`, y
 * WhatsApp (Meta) no acepta WebM: de audio solo toma AAC, MP4, MPEG, AMR y
 * OGG con Opus. El audio Opus ya está bien; lo único que cambia es el
 * contenedor. Aquí se leen los paquetes Opus del WebM (Matroska/EBML) y se
 * reescriben en páginas Ogg (RFC 7845), con su OpusHead y su OpusTags.
 * Firefox ya graba en `audio/ogg` y Safari en `audio/mp4` (AAC): esos pasan
 * tal cual.
 */

export class WebmOpusError extends Error {}

/** ¿Es un audio WebM/Matroska que hay que pasar a Ogg antes de mandarlo a WhatsApp? */
export function isWebmAudio(mime: unknown, name: unknown): boolean {
  const m = String(mime ?? "").toLowerCase();
  if (/^(audio|video)\/(webm|x-matroska)/.test(m)) return true;
  return !m.startsWith("audio/ogg") && /\.(webm|weba|mka)$/i.test(String(name ?? ""));
}

// ── EBML ────────────────────────────────────────────────────────────────────

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Cluster: 0x1f43b675,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  Audio: 0xe1,
  BlockGroup: 0xa0,
  TrackNumber: 0xd7,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Channels: 0x9f,
  SamplingFrequency: 0xb5,
  SimpleBlock: 0xa3,
  Block: 0xa1,
};

/** Elementos cuyo contenido se recorre (se "aplanan": interesan las hojas, en orden). */
const MASTERS = new Set([ID.Segment, ID.Cluster, ID.Tracks, ID.TrackEntry, ID.Audio, ID.BlockGroup]);

function readVint(b: Uint8Array, pos: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } | null {
  if (pos >= b.length) return null;
  const first = b[pos];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || pos + len > b.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function readUint(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

function readFloat(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length === 4) return dv.getFloat32(0);
  if (b.length === 8) return dv.getFloat64(0);
  return 0;
}

interface Track { number: number; codec: string; priv: Uint8Array | null; channels: number; rate: number }

/** Paquetes Opus del WebM, en orden, más los datos de la pista. */
export function readWebmOpus(b: Uint8Array): { packets: Uint8Array[]; head: Uint8Array | null; channels: number; rate: number } {
  const tracks: Track[] = [];
  let cur: Track | null = null;
  const blocks: { track: number; data: Uint8Array }[] = [];
  let pos = 0;
  while (pos < b.length) {
    const id = readVint(b, pos, true);
    if (!id) break;
    const size = readVint(b, pos + id.len, false);
    if (!size) break;
    const start = pos + id.len + size.len;
    if (MASTERS.has(id.value)) {
      if (id.value === ID.TrackEntry) {
        cur = { number: 0, codec: "", priv: null, channels: 1, rate: 48000 };
        tracks.push(cur);
      }
      pos = start; // se entra en el elemento (tamaño conocido o no)
      continue;
    }
    // Una hoja de tamaño desconocido no se puede saltar: el archivo está roto.
    if (size.unknown) throw new WebmOpusError("El audio WebM está dañado.");
    const end = start + size.value;
    // El último bloque puede venir cortado: un paquete Opus a medias no se manda.
    if (end > b.length) break;
    const data = b.subarray(start, end);
    switch (id.value) {
      case ID.TrackNumber: if (cur) cur.number = readUint(data); break;
      case ID.CodecID: if (cur) cur.codec = new TextDecoder().decode(data).replace(/\0+$/, ""); break;
      case ID.CodecPrivate: if (cur) cur.priv = data; break;
      case ID.Channels: if (cur) cur.channels = readUint(data) || 1; break;
      case ID.SamplingFrequency: if (cur) cur.rate = Math.round(readFloat(data)) || 48000; break;
      case ID.SimpleBlock:
      case ID.Block: {
        const tn = readVint(data, 0, false);
        if (!tn || data.length < tn.len + 3) break;
        const flags = data[tn.len + 2];
        if (flags & 0x06) throw new WebmOpusError("El audio WebM usa lacing, que no se puede convertir.");
        blocks.push({ track: tn.value, data: data.subarray(tn.len + 3) });
        break;
      }
    }
    pos = start + size.value;
  }
  const opus = tracks.find((t) => t.codec === "A_OPUS");
  if (!opus) throw new WebmOpusError("El audio no es Opus: WhatsApp no lo aceptaría.");
  const packets = blocks.filter((x) => x.track === opus.number && x.data.length > 0).map((x) => x.data);
  if (!packets.length) throw new WebmOpusError("La grabación no tiene audio.");
  const head = opus.priv && opus.priv.length >= 19 && new TextDecoder().decode(opus.priv.subarray(0, 8)) === "OpusHead" ? opus.priv : null;
  return { packets, head, channels: opus.channels, rate: opus.rate };
}

// ── Opus ────────────────────────────────────────────────────────────────────

/** Muestras (a 48 kHz) que trae un paquete Opus, por su byte TOC (RFC 6716 §3.1). */
export function opusPacketSamples(p: Uint8Array): number {
  if (!p.length) return 0;
  const toc = p[0];
  const config = toc >> 3;
  let frame: number; // en muestras a 48 kHz
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3];
  else if (config < 16) frame = [480, 960][config & 1];
  else frame = [120, 240, 480, 960][config & 3];
  const c = toc & 3;
  const count = c === 0 ? 1 : c === 3 ? (p.length > 1 ? p[1] & 0x3f : 0) : 2;
  return frame * count;
}

function opusHead(channels: number, rate: number): Uint8Array {
  const h = new Uint8Array(19);
  h.set(new TextEncoder().encode("OpusHead"));
  const dv = new DataView(h.buffer);
  h[8] = 1;
  h[9] = Math.min(Math.max(channels, 1), 2);
  dv.setUint16(10, 312, true); // pre-skip estándar de libopus
  dv.setUint32(12, rate, true);
  return h;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("predictable.ai");
  const t = new Uint8Array(8 + 4 + vendor.length + 4);
  t.set(new TextEncoder().encode("OpusTags"));
  const dv = new DataView(t.buffer);
  dv.setUint32(8, vendor.length, true);
  t.set(vendor, 12);
  dv.setUint32(12 + vendor.length, 0, true);
  return t;
}

// ── Ogg ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** CRC de las páginas Ogg (polinomio 0x04C11DB7, sin reflejar, inicio 0). */
export function oggCrc(b: Uint8Array): number {
  let crc = 0;
  for (const x of b) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ x) & 0xff]) >>> 0;
  return crc >>> 0;
}

function oggPage(packets: Uint8Array[], granule: number, serial: number, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const bodyLen = packets.reduce((s, p) => s + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLen);
  const dv = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  page[4] = 0;
  page[5] = flags;
  dv.setUint32(6, granule % 0x100000000, true);
  dv.setUint32(10, Math.floor(granule / 0x100000000), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, seq, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let off = 27 + lacing.length;
  for (const p of packets) { page.set(p, off); off += p.length; }
  dv.setUint32(22, oggCrc(page), true);
  return page;
}

/** Paquetes por página de audio (~1 s con tramas de 20 ms): muy por debajo de los 255 segmentos. */
const PACKETS_PER_PAGE = 50;

/** WebM/Opus → Ogg/Opus. Lanza WebmOpusError si el archivo no es Opus o está dañado. */
export function webmOpusToOgg(webm: Uint8Array, serial = 0x50414931): Uint8Array<ArrayBuffer> {
  const { packets, head: rawHead, channels, rate } = readWebmOpus(webm);
  const head = rawHead ?? opusHead(channels, rate);
  const preSkip = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true);
  const pages: Uint8Array[] = [oggPage([head], 0, serial, 0, 0x02), oggPage([opusTags()], 0, serial, 1, 0)];
  let granule = preSkip;
  let seq = 2;
  for (let i = 0; i < packets.length; i += PACKETS_PER_PAGE) {
    const group = packets.slice(i, i + PACKETS_PER_PAGE).filter((p) => p.length < 255 * 255);
    for (const p of group) granule += opusPacketSamples(p);
    const last = i + PACKETS_PER_PAGE >= packets.length;
    pages.push(oggPage(group, granule, serial, seq++, last ? 0x04 : 0));
  }
  const out = new Uint8Array(pages.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of pages) { out.set(p, off); off += p.length; }
  return out;
}
