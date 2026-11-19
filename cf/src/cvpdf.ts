// A CV as a one-page PDF, drawn straight from its content (the same .json
// `npm run cv` stores): the name, the title, a contact line with icons,
// sections with a rule under the heading, each job's title on the left and
// its dates on the right, bullets, skills, languages. The layout is the one
// scripts/cv-build.mjs makes as a .docx, measured off its PDF.
//
// The font is Amiri, cut down to Latin and embedded (src/cvassets.ts), with
// a ToUnicode map so the text can be copied - and read by application
// software. No library: a PDF is numbered objects and a table of where they
// start.
import { CV_FONTS, CV_ICONS } from "./cvassets.ts";

export interface CvEntry { title: string; org: string; url?: string; dates?: string; place?: string; about?: string; bullets?: string[] }
export interface CvVersion {
  title?: string; doctitle?: string;
  h?: { profile?: string; work?: string; edu?: string; skills?: string; langs?: string };
  profile?: string; jobs?: CvEntry[]; edu?: CvEntry[];
  skills?: [string, string][]; langs?: [string, string][];
}
export interface CvContact { place?: string; email?: string; phone?: string; github?: string; linkedin?: string }
export interface CvBase { name: string; contact?: CvContact; versions: Record<string, CvVersion> }

// ---------------------------------------------------------------- the font
type Style = "Regular" | "Bold" | "Italic";
interface Face { name: string; key: string; glyphs: Map<number, [number, number]>; used: Map<number, number>; data: string; ascent: number; descent: number; cap: number; bbox: readonly number[]; italic: number }
const parsed: Partial<Record<Style, Map<number, [number, number]>>> = {};
function glyphsOf(style: Style): Map<number, [number, number]> {
  let m = parsed[style];
  if (!m) {
    m = new Map();
    for (const e of CV_FONTS[style].table.split(",")) {
      const [c, g, w] = e.split(":").map(Number);
      m.set(c, [g, w]);
    }
    parsed[style] = m;
  }
  return m;
}
const KEYS: Record<Style, string> = { Regular: "F1", Bold: "F2", Italic: "F3" };
const newFaces = (): Record<Style, Face> => {
  const f = (s: Style): Face => ({ ...CV_FONTS[s], key: KEYS[s], glyphs: glyphsOf(s), used: new Map() });
  return { Regular: f("Regular"), Bold: f("Bold"), Italic: f("Italic") };
};
const SKIP = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);
/** The glyphs for a text, as [glyph, width, character]; what the font lacks becomes "?". */
function shape(face: Face, text: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const ch of text) {
    let c = ch.codePointAt(0)!;
    if (SKIP.has(c)) continue;
    let g = face.glyphs.get(c);
    if (!g) { c = 63; g = face.glyphs.get(63)!; }
    out.push([g[0], g[1], c]);
  }
  return out;
}
const widthOf = (face: Face, text: string, size: number) => shape(face, text).reduce((a, g) => a + g[1], 0) * size / 1000;

// ---------------------------------------------------------------- the layout (points, from the top of an A4 page)
const PAGE_W = 595.28, PAGE_H = 841.89;
const LEFT = 57.5, RIGHT = 547, BULLET_X = 68, BULLET_TEXT = 76.2, BOTTOM = 814;
const BODY = 10.5, PITCH = 13.3;
const GREY = 0.27;

interface Run { text: string; style: Style; size: number; grey?: boolean }
/** "**bold**" in a text: runs of regular and bold. */
const rich = (text: string, size = BODY, style: Style = "Regular"): Run[] =>
  String(text).split(/(\*\*[^*]+\*\*)/).filter(Boolean)
    .map((p) => (p.startsWith("**") ? { text: p.slice(2, -2), style: "Bold" as Style, size } : { text: p, style, size }));

export interface CvPdf { pdf: Uint8Array; overflow: number }

/** One version of a CV as a PDF; overflow > 0: it runs that many points past the page. measure: only the overflow, no file. */
export function cvPdf(base: CvBase, v: CvVersion, lang = "de", measure = false): CvPdf {
  const faces = newFaces();
  const ops: string[] = [];
  const links: { x1: number; y1: number; x2: number; y2: number; url: string }[] = [];
  const images = new Set<string>();
  let y = 0;                                                    // the last baseline drawn

  // text at a baseline, one run after another; returns where it ends
  const draw = (runs: Run[], x: number, base: number): number => {
    for (const r of runs) {
      const face = faces[r.style];
      const gl = shape(face, r.text);
      if (!gl.length) continue;
      for (const [g, , c] of gl) face.used.set(g, c);
      const hex = gl.map(([g]) => g.toString(16).padStart(4, "0")).join("");
      ops.push(`BT ${r.grey ? `${GREY} g ` : ""}/${face.key} ${r.size} Tf ${x.toFixed(2)} ${(PAGE_H - base).toFixed(2)} Td <${hex}> Tj ET${r.grey ? " 0 g" : ""}`);
      x += gl.reduce((a, g) => a + g[1], 0) * r.size / 1000;
    }
    return x;
  };
  const runsWidth = (runs: Run[]) => runs.reduce((a, r) => a + widthOf(faces[r.style], r.text, r.size), 0);
  // runs broken into lines no wider than the width, at spaces (not at a no-break space)
  const wrap = (runs: Run[], width: number, firstWidth = width): Run[][] => {
    const words: Run[] = [];
    for (const r of runs) for (const w of r.text.split(/(?<= )/)) if (w) words.push({ ...r, text: w });
    const lines: Run[][] = [[]];
    let used = 0;
    for (const w of words) {
      const max = lines.length === 1 ? firstWidth : width;
      const ww = widthOf(faces[w.style], w.text.trimEnd(), w.size);
      if (used + ww > max && lines[lines.length - 1].length) { lines.push([]); used = 0; }
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last.style === w.style && last.size === w.size && last.grey === w.grey) last.text += w.text;
      else line.push({ ...w });
      used += widthOf(faces[w.style], w.text, w.size);
    }
    for (const l of lines) if (l.length) l[l.length - 1].text = l[l.length - 1].text.trimEnd();
    return lines;
  };
  const icon = (name: keyof typeof CV_ICONS, x: number, base: number, size: number) => {
    images.add(name);
    ops.push(`q ${size} 0 0 ${size} ${x.toFixed(2)} ${(PAGE_H - base - size * 0.08).toFixed(2)} cm /I${name} Do Q`);
  };
  const link = (url: string, x1: number, x2: number, base: number, size: number) =>
    links.push({ x1, x2, y1: PAGE_H - base - size * 0.3, y2: PAGE_H - base + size * 0.85, url });

  // the name, the title, the contact line
  y = 57.9;
  draw([{ text: base.name, style: "Bold", size: 25 }], LEFT, y);
  if (v.title) { y += 29.2; draw([{ text: v.title, style: "Italic", size: 16.5 }], LEFT, y); }
  const c = base.contact ?? {};
  const bare = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const bits: [keyof typeof CV_ICONS, string, string | null][] = [];
  if (c.place) bits.push(["pin", c.place, null]);
  if (c.email) bits.push(["mail", c.email, `mailto:${c.email}`]);
  if (c.phone) bits.push(["phone", c.phone, `tel:${c.phone.replace(/[^\d+]/g, "")}`]);
  if (c.github) bits.push(["github", bare(c.github), `https://${bare(c.github)}`]);
  if (c.linkedin) bits.push(["linkedin", bare(c.linkedin), `https://www.${bare(c.linkedin)}/`]);
  if (bits.length) {
    y += 25.2;
    let x = LEFT;
    for (const [ic, text, url] of bits) {
      icon(ic, x, y, 9);
      const start = x;
      x = draw([{ text, style: "Regular", size: 9.5 }], x + 12, y);
      if (url) link(url, start, x, y, 9.5);
      x += 12;
    }
  }

  const heading = (text: string) => {
    y += 26.6;
    draw([{ text, style: "Bold", size: 11.5 }], LEFT, y);
    const ry = y + 9.3;
    ops.push(`1.5 w ${LEFT} ${(PAGE_H - ry).toFixed(2)} m ${RIGHT} ${(PAGE_H - ry).toFixed(2)} l S`);
    y = ry + 15.2 - PITCH;                                       // the next line goes one pitch down from here
  };
  const lines = (lns: Run[][], x: number, pitch = PITCH, firstX = x) => {
    lns.forEach((l, i) => { y += pitch; draw(l, i === 0 ? firstX : x, y); });
  };
  const entries = (list: CvEntry[]) => list.forEach((e, i) => {
    y += i === 0 ? PITCH : 19.5;
    let x = draw([{ text: `${e.title}, `, style: "Bold", size: BODY }, { text: e.org, style: "Italic", size: BODY }], LEFT, y);
    if (e.url) { icon("ext", x + 2.5, y, 6.75); link(e.url, x + 2.5, x + 9.25, y, BODY); }
    const right = [e.dates, e.place].filter(Boolean).join("  |  ");
    if (right) draw([{ text: right, style: "Regular", size: BODY }], RIGHT - widthOf(faces.Regular, right, BODY), y);
    if (e.about) { y += 12.9; draw([{ text: e.about, style: "Italic", size: 10, grey: true }], LEFT, y); y += 14.1 - PITCH; }
    for (const b of e.bullets ?? []) {
      const lns = wrap(rich(b), RIGHT - BULLET_TEXT);
      y += PITCH; draw([{ text: "•", style: "Regular", size: BODY }], BULLET_X, y); y -= PITCH;
      lines(lns, BULLET_TEXT);
    }
  });

  const h = v.h ?? {};
  if (v.profile) { heading(h.profile ?? "Profile"); lines(wrap(rich(v.profile), RIGHT - LEFT), LEFT); }
  if (v.jobs?.length) { heading(h.work ?? "Work Experience"); entries(v.jobs); }
  if (v.edu?.length) { heading(h.edu ?? "Education"); entries(v.edu); }
  if (v.skills?.length) {
    heading(h.skills ?? "Skills");
    v.skills.forEach(([k, s], i) => {
      const label: Run = { text: `${k} `, style: "Bold", size: BODY };
      lines(wrap([label, ...rich(s)], RIGHT - LEFT), LEFT, i === 0 ? PITCH : 15.35);
    });
  }
  if (v.langs?.length) {
    heading(h.langs ?? "Languages");
    lines(wrap(v.langs.flatMap(([k, s], i) => [{ text: `${k} `, style: "Bold" as Style, size: BODY },
      { text: s + (i < v.langs!.length - 1 ? ", " : ""), style: "Regular" as Style, size: BODY }]), RIGHT - LEFT), LEFT);
  }
  if (measure) return { pdf: new Uint8Array(), overflow: Math.max(0, y + 4 - BOTTOM) };
  return { pdf: assemble(faces, ops.join("\n"), links, [...images], v.doctitle || base.name, lang), overflow: Math.max(0, y + 4 - BOTTOM) };
}

// ---------------------------------------------------------------- the file
const enc = new TextEncoder();
// the font files and icons, decoded once per Worker instance
const decoded = new Map<string, Uint8Array>();
const b64 = (s: string) => {
  let d = decoded.get(s);
  if (!d) {
    const bin = atob(s);
    d = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i);
    decoded.set(s, d);
  }
  return d;
};
const pdfString = (s: string) => `(${[...s].map((ch) => {
  const c = ch.charCodeAt(0);
  return ch === "(" || ch === ")" || ch === "\\" ? `\\${ch}` : c < 32 || c > 126 ? "?" : ch;
}).join("")})`;
// a text string the reader shows as is: UTF-16 with a byte-order mark
const utf16 = (s: string) => `<FEFF${[...s].map((ch) => { const c = ch.codePointAt(0)!; return c > 0xffff ? "003F" : c.toString(16).padStart(4, "0"); }).join("")}>`;

function assemble(faces: Record<Style, Face>, content: string, links: { x1: number; y1: number; x2: number; y2: number; url: string }[],
  images: string[], title: string, lang: string): Uint8Array {
  const objs: (string | [string, Uint8Array])[] = [];          // [dictionary, stream] for streams
  const add = (o: string | [string, Uint8Array]) => { objs.push(o); return objs.length; };
  const stream = (dict: string, data: Uint8Array) => add([`<< ${dict} /Length ${data.length} >>`, data]);

  const fontRefs: string[] = [];
  for (const style of ["Regular", "Bold", "Italic"] as Style[]) {
    const f = faces[style];
    if (!f.used.size) continue;
    const data = b64(f.data);
    const file = stream(`/Length1 ${data.length}`, data);
    const desc = add(`<< /Type /FontDescriptor /FontName /${f.name} /Flags ${style === "Italic" ? 98 : 34} /FontBBox [${f.bbox.join(" ")}] ` +
      `/ItalicAngle ${f.italic} /Ascent ${f.ascent} /Descent ${f.descent} /CapHeight ${f.cap} /StemV ${style === "Bold" ? 140 : 80} /FontFile2 ${file} 0 R >>`);
    const used = [...f.used.keys()].sort((a, b) => a - b);
    const width = new Map<number, number>();
    for (const [, [g, w]] of f.glyphs) width.set(g, w);
    const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${f.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 500 /W [${used.map((g) => `${g} [${width.get(g) ?? 500}]`).join(" ")}] >>`);
    const cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def " +
      "/CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n" +
      chunks(used, 100).map((part) => `${part.length} beginbfchar\n${part.map((g) => `<${g.toString(16).padStart(4, "0")}> <${f.used.get(g)!.toString(16).padStart(4, "0")}>`).join("\n")}\nendbfchar`).join("\n") +
      "\nendcmap CMapName currentdict /CMap defineresource pop end end";
    const tu = stream("", enc.encode(cmap));
    fontRefs.push(`/${f.key} ${add(`<< /Type /Font /Subtype /Type0 /BaseFont /${f.name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tu} 0 R >>`)} 0 R`);
  }
  const imgRefs = images.map((n) => {
    const i = CV_ICONS[n as keyof typeof CV_ICONS];
    return `/I${n} ${stream(`/Type /XObject /Subtype /Image /Width ${i.w} /Height ${i.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, b64(i.data))} 0 R`;
  });
  const contents = stream("", enc.encode(content));
  const annots = links.map((l) => add(`<< /Type /Annot /Subtype /Link /Rect [${[l.x1, l.y1, l.x2, l.y2].map((n) => n.toFixed(1)).join(" ")}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(l.url)} >> >>`));
  const pagesNo = objs.length + 2;                               // the page, then the page tree
  const page = add(`<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contents} 0 R ` +
    `/Resources << /Font << ${fontRefs.join(" ")} >> /XObject << ${imgRefs.join(" ")} >> >> /Annots [${annots.map((a) => `${a} 0 R`).join(" ")}] >>`);
  add(`<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  const info = add(`<< /Title ${utf16(title)} /Producer (neustart) >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesNo} 0 R /Lang (${lang}) >>`);

  const parts: Uint8Array[] = [];
  parts[0] = Uint8Array.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", (ch) => ch.charCodeAt(0));
  let size = parts[0].length;
  const at: number[] = [];
  objs.forEach((o, i) => {
    at.push(size);
    const chunk = typeof o === "string"
      ? [enc.encode(`${i + 1} 0 obj\n${o}\nendobj\n`)]
      : [enc.encode(`${i + 1} 0 obj\n${o[0]}\nstream\n`), o[1], enc.encode("\nendstream\nendobj\n")];
    for (const p of chunk) { parts.push(p); size += p.length; }
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}` +
    `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  const out = new Uint8Array(size + parts[parts.length - 1].length);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
const chunks = <T>(a: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

// decoded while the Worker starts, so a request doesn't pay for it
for (const s of ["Regular", "Bold", "Italic"] as Style[]) { glyphsOf(s); b64(CV_FONTS[s].data); }
for (const i of Object.values(CV_ICONS)) b64(i.data);
