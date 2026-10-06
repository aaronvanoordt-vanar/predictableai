/**
 * deno test supabase/functions/_shared/webm-opus.test.ts
 *
 * Cubre la conversión de las notas de voz de la bandeja (WebM/Opus de
 * Chrome → Ogg/Opus que acepta WhatsApp): lectura del EBML con Segment y
 * Cluster de tamaño desconocido (así graba MediaRecorder), duración de los
 * paquetes Opus, páginas Ogg con CRC válido y la detección del WebM.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { isWebmAudio, oggCrc, opusPacketSamples, readWebmOpus, WebmOpusError, webmOpusToOgg } from "./webm-opus.ts";

const enc = new TextEncoder();

function vsize(n: number): number[] {
  // Tamaño EBML en 4 bytes (0x10 = marcador de longitud 4).
  return [0x10 | ((n >>> 24) & 0x0f), (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function idBytes(id: number): number[] {
  const out: number[] = [];
  let v = id;
  while (v > 0) { out.unshift(v & 0xff); v = Math.floor(v / 256); }
  return out;
}
function el(id: number, data: number[] | Uint8Array): number[] {
  return [...idBytes(id), ...vsize(data.length), ...data];
}
function unknownSize(id: number, children: number[]): number[] {
  return [...idBytes(id), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...children];
}
function opusHead(preSkip = 312): number[] {
  return [...enc.encode("OpusHead"), 1, 1, preSkip & 0xff, preSkip >> 8, 0x80, 0xbb, 0, 0, 0, 0, 0];
}
function simpleBlock(track: number, packet: number[], flags = 0x80): number[] {
  return el(0xa3, [0x80 | track, 0, 0, flags, ...packet]);
}

/** WebM como lo graba Chrome: Segment y Cluster sin tamaño, una pista A_OPUS. */
function chromeLikeWebm(packets: number[][], opts: { codec?: string; head?: boolean; flags?: number } = {}): Uint8Array {
  const track = [
    ...el(0xd7, [1]),
    ...el(0x86, [...enc.encode(opts.codec ?? "A_OPUS")]),
    ...(opts.head === false ? [] : el(0x63a2, opusHead())),
    ...el(0xe1, [...el(0x9f, [1]), ...el(0xb5, [0x47, 0x3b, 0x80, 0x00])]), // 48000.0 float32
  ];
  const cluster = unknownSize(0x1f43b675, [...el(0xe7, [0]), ...packets.flatMap((p) => simpleBlock(1, p, opts.flags))]);
  return new Uint8Array([
    ...el(0x1a45dfa3, [...el(0x4282, [...enc.encode("webm")])]),
    ...unknownSize(0x18538067, [...el(0x1654ae6b, el(0xae, track)), ...cluster]),
  ]);
}

/** Recorre las páginas Ogg: comprueba "OggS" y el CRC de cada una. */
function pages(ogg: Uint8Array) {
  const out: { flags: number; granule: number; seq: number; packets: Uint8Array[] }[] = [];
  let pos = 0;
  while (pos < ogg.length) {
    assertEquals(new TextDecoder().decode(ogg.subarray(pos, pos + 4)), "OggS");
    const dv = new DataView(ogg.buffer, ogg.byteOffset + pos);
    const nseg = ogg[pos + 26];
    const lacing = [...ogg.subarray(pos + 27, pos + 27 + nseg)];
    const bodyLen = lacing.reduce((s, x) => s + x, 0);
    const page = ogg.slice(pos, pos + 27 + nseg + bodyLen);
    const crc = new DataView(page.buffer).getUint32(22, true);
    page.fill(0, 22, 26);
    assertEquals(oggCrc(page), crc, "CRC de la página");
    const packets: Uint8Array[] = [];
    let off = pos + 27 + nseg, len = 0;
    for (const l of lacing) { len += l; if (l < 255) { packets.push(ogg.subarray(off, off + len)); off += len; len = 0; } }
    out.push({ flags: ogg[pos + 5], granule: dv.getUint32(6, true) + dv.getUint32(10, true) * 2 ** 32, seq: dv.getUint32(18, true), packets });
    pos += 27 + nseg + bodyLen;
  }
  return out;
}

// TOC 0xF8 = config 31 (CELT 20 ms), una trama → 960 muestras a 48 kHz.
const PKT = (n: number) => [0xf8, ...Array.from({ length: n }, (_, i) => i & 0xff)];

Deno.test("oggCrc: vector conocido (poly 0x04C11DB7, inicio 0, sin reflejar)", () => {
  assertEquals(oggCrc(enc.encode("123456789")), 0x89a1897f);
});

Deno.test("opusPacketSamples: duración por el byte TOC", () => {
  assertEquals(opusPacketSamples(new Uint8Array([0xf8])), 960); // CELT 20 ms
  assertEquals(opusPacketSamples(new Uint8Array([0x08 | 3 << 3])), 2880); // SILK 60 ms (config 3)
  assertEquals(opusPacketSamples(new Uint8Array([0x78 | 1])), 1920); // hybrid 20 ms (config 15), 2 tramas
  assertEquals(opusPacketSamples(new Uint8Array([0xf8 | 3, 3])), 2880); // CELT 20 ms × 3 tramas (code 3)
  assertEquals(opusPacketSamples(new Uint8Array([])), 0);
});

Deno.test("isWebmAudio: WebM y Matroska sí; ogg, mp4 y mp3 no", () => {
  assert(isWebmAudio("audio/webm;codecs=opus", "nota.webm"));
  assert(isWebmAudio("video/webm", "x"));
  assert(isWebmAudio("", "nota-de-voz.webm"));
  assert(!isWebmAudio("audio/ogg;codecs=opus", "nota.ogg"));
  assert(!isWebmAudio("audio/mp4", "nota.m4a"));
  assert(!isWebmAudio("audio/mpeg", "nota.mp3"));
});

Deno.test("webmOpusToOgg: grabación de Chrome → Ogg/Opus válido", () => {
  const packets = Array.from({ length: 120 }, (_, i) => PKT(20 + (i % 7)));
  const ogg = webmOpusToOgg(chromeLikeWebm(packets));
  const ps = pages(ogg);
  assertEquals(ps[0].flags, 0x02, "la primera página abre el stream (BOS)");
  assertEquals(new TextDecoder().decode(ps[0].packets[0].subarray(0, 8)), "OpusHead");
  assertEquals(new TextDecoder().decode(ps[1].packets[0].subarray(0, 8)), "OpusTags");
  assertEquals(ps[ps.length - 1].flags, 0x04, "la última cierra el stream (EOS)");
  assertEquals(ps.map((p) => p.seq), ps.map((_, i) => i));
  const audio = ps.slice(2).flatMap((p) => p.packets);
  assertEquals(audio.length, 120);
  assertEquals([...audio[5]], packets[5]);
  assertEquals(ps[ps.length - 1].granule, 312 + 120 * 960, "granule = pre-skip + muestras");
  for (let i = 3; i < ps.length; i++) assert(ps[i].granule > ps[i - 1].granule);
});

Deno.test("webmOpusToOgg: sin CodecPrivate arma un OpusHead propio", () => {
  const ps = pages(webmOpusToOgg(chromeLikeWebm([PKT(10), PKT(10)], { head: false })));
  const head = ps[0].packets[0];
  assertEquals(head.length, 19);
  assertEquals(head[9], 1, "mono");
  assertEquals(new DataView(head.buffer, head.byteOffset).getUint32(12, true), 48000);
});

Deno.test("readWebmOpus: descarta el último bloque cortado", () => {
  const full = chromeLikeWebm([PKT(30), PKT(30), PKT(30)]);
  const { packets } = readWebmOpus(full.subarray(0, full.length - 10));
  assertEquals(packets.length, 2);
});

Deno.test("webmOpusToOgg: rechaza lo que WhatsApp no aceptaría", () => {
  assertThrows(() => webmOpusToOgg(chromeLikeWebm([PKT(10)], { codec: "A_VORBIS" })), WebmOpusError);
  assertThrows(() => webmOpusToOgg(chromeLikeWebm([])), WebmOpusError);
  assertThrows(() => webmOpusToOgg(chromeLikeWebm([PKT(10)], { flags: 0x82 })), WebmOpusError);
  assertThrows(() => webmOpusToOgg(enc.encode("no es un webm")), WebmOpusError);
});
