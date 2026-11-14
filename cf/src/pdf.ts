// A small PDF writer for a one- or two-page letter: Helvetica (built into
// every PDF reader, so nothing is embedded), A4, the sender's name and
// contact on top, the date on the right, a bold subject, then the text,
// wrapped to the page. Umlauts and € through WinAnsi, the font's own
// encoding. No library: a PDF is a few numbered text objects and a table of
// where they start.

export interface LetterPdf {
  name: string;
  contact: string[];      // address, email, phone - each on its own line
  place_date: string;     // "Cottbus, 14.11.2026"
  subject: string;
  salutation: string;
  body: string;           // paragraphs, separated by blank lines
  closing: string;        // "Mit freundlichen Grüßen"
}

// Helvetica's widths (per 1000 units of the font size), from its metrics
const W: Record<string, number> = {};
" !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~".split("").forEach((c, i) => {
  W[c] = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611,
    722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584][i];
});
Object.assign(W, { "ä": 556, "ö": 556, "ü": 556, "Ä": 667, "Ö": 778, "Ü": 722, "ß": 611, "é": 556, "è": 556, "€": 556, "–": 556, "—": 1000,
  "„": 333, "“": 333, "”": 333, "‘": 222, "’": 222, "•": 350, "…": 1000 });
const width = (s: string, size: number, bold = false) => [...s].reduce((a, c) => a + (W[c] ?? 556), 0) * size / 1000 * (bold ? 1.06 : 1);

// WinAnsi: the bytes Helvetica knows for the letters beyond ASCII
const WIN: Record<string, number> = { "€": 0x80, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97 };
function enc(s: string): string {
  let out = "";
  for (const c of s) {
    const code = c.codePointAt(0)!;
    const b = WIN[c] ?? (code < 256 ? code : 63);           // anything else: "?"
    const ch = String.fromCharCode(b);
    out += ch === "(" || ch === ")" || ch === "\\" ? `\\${ch}` : ch;
  }
  return out;
}

/** Lines that fit the width, breaking at spaces. */
function wrap(text: string, size: number, max: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (width(next, size, bold) <= max || !line) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

export function letterPdf(l: LetterPdf): Uint8Array {
  const PAGE_W = 595, PAGE_H = 842, LEFT = 71, RIGHT = 57, TOP = 70, BOTTOM = 70, MAX = PAGE_W - LEFT - RIGHT;
  const pages: string[] = [];
  let ops: string[] = [], y = PAGE_H - TOP;
  const text = (s: string, x: number, size: number, bold = false) =>
    ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${enc(s)}) Tj ET`);
  const down = (h: number) => {
    y -= h;
    if (y < BOTTOM) { pages.push(ops.join("\n")); ops = []; y = PAGE_H - TOP - h; }
  };
  // the sender, then a thin line
  text(l.name, LEFT, 13, true); down(14);
  for (const c of l.contact.filter(Boolean)) { text(c, LEFT, 9); down(11); }
  ops.push(`0.6 w 0.6 G ${LEFT} ${(y + 3).toFixed(1)} m ${PAGE_W - RIGHT} ${(y + 3).toFixed(1)} l S 0 G`);
  down(36);
  // the date on the right, the subject in bold
  text(l.place_date, PAGE_W - RIGHT - width(l.place_date, 11), 11); down(34);
  for (const line of wrap(l.subject, 11.5, MAX, true)) { text(line, LEFT, 11.5, true); down(16); }
  down(14);
  text(l.salutation, LEFT, 11); down(22);
  for (const para of l.body.split(/\n\s*\n/)) {
    for (const line of wrap(para.trim(), 11, MAX)) { text(line, LEFT, 11); down(15.5); }
    down(8);
  }
  down(8);
  text(l.closing, LEFT, 11); down(30);
  text(l.name, LEFT, 11);
  pages.push(ops.join("\n"));

  // the objects: 1 catalog, 2 pages, 3-4 fonts, then a page and its content per page
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((content, i) => {
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const at: number[] = [];
  for (let n = 1; n < objs.length; n++) { at[n] = out.length; out += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + at.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // every character is one byte (WinAnsi), so the offsets above are byte offsets
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
}
