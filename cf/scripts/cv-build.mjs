// A CV as .docx from its content (cv/<id>.json): one page, a serif font,
// the name and title on top, a contact line with icons, sections with a rule
// under the heading, the dates on the right. One file per language.
//
// The .json:
//   { "name": "…", "font": "Amiri",                       (font: optional)
//     "contact": { "place", "email", "phone", "github", "linkedin" },   (all optional)
//     "versions": { "de": { … }, "en": { … } } }
// and each version:
//   { "title": "Data Scientist · Werkstudentin",
//     "doctitle": "… - Lebenslauf",                        (the file's own title)
//     "h": { "profile", "work", "edu", "skills", "langs" }, (the headings)
//     "profile": "a short paragraph",
//     "jobs": [ { "title", "org", "url", "dates", "place", "about", "bullets": [] } ],
//     "edu":  [ the same, without about ],
//     "skills": [ ["Programming:", "Python, SQL"] ],
//     "langs":  [ ["German:", "B2"] ] }
// In a bullet, **…** is bold.
//
// Made to look the same in Word and in Google Docs, which drops exact line
// spacing and right tab stops on import: line heights are multiples of the
// font's own line, and the dates sit in an invisible two-column table.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  Document, Packer, Paragraph, TextRun, ImageRun, ExternalHyperlink,
  BorderStyle, LevelFormat, AlignmentType, LineRuleType, Table, TableRow, TableCell, WidthType, TableLayoutType,
} from "docx";

const ICONS = resolve(dirname(new URL(import.meta.url).pathname), "cv-icons");
const W = 11906, H = 16838, LEFT = 1150, RIGHT = 960, TEXT_W = W - LEFT - RIGHT;   // A4, in twentieths of a point
const L_W = 6196, R_W = TEXT_W - L_W;                                                // title | dates
const BODY = 0.72;                                                                   // Amiri's own line is ~1.9x its size

/** The .docx files for a CV's content: [{ lang, data }]. */
export async function buildCv(cv) {
  const FONT = cv.font || "Amiri";
  const t = (text, o = {}) => new TextRun({ text, font: FONT, size: 21, ...o });   // 10.5 pt
  const line = (m) => ({ line: Math.round(240 * m), lineRule: LineRuleType.AUTO });
  const img = (name, size = 12) => new ImageRun({ type: "png", data: readFileSync(resolve(ICONS, `${name}.png`)), transformation: { width: size, height: size } });
  const link = (url, children) => new ExternalHyperlink({ link: url, children });
  const rich = (text) => String(text).split(/(\*\*[^*]+\*\*)/).filter(Boolean)
    .map((p) => (p.startsWith("**") ? t(p.slice(2, -2), { bold: true }) : t(p)));

  const heading = (text) => new Paragraph({
    spacing: { before: 230, after: 120, ...line(0.8) },
    border: { bottom: { style: BorderStyle.SINGLE, size: 14, color: "000000", space: 3 } },
    keepNext: true, children: [t(text, { bold: true, size: 23 })],
  });
  const bullet = (text) => new Paragraph({ numbering: { reference: "dots", level: 0 }, spacing: { before: 0, after: 0, ...line(BODY) }, children: rich(text) });
  const NONE = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
  const cell = (w, align, children) => new TableCell({ width: { size: w, type: WidthType.DXA }, borders: NO_BORDERS,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    children: [new Paragraph({ alignment: align, keepNext: true, spacing: { before: 0, after: 0, ...line(BODY) }, children })] });
  const space = (pt) => new Paragraph({ spacing: { before: 0, after: 0, line: pt * 20, lineRule: LineRuleType.EXACT }, children: [t("", { size: 2 })] });
  const entry = (e, first) => [
    ...(first ? [] : [space(4)]),
    new Table({
      width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: [L_W, R_W], layout: TableLayoutType.FIXED, borders: NO_BORDERS,
      rows: [new TableRow({ cantSplit: true, children: [
        cell(L_W, AlignmentType.LEFT, [t(`${e.title}, `, { bold: true }), t(e.org, { italics: true }), ...(e.url ? [t(" "), link(e.url, [img("ext", 9)])] : [])]),
        cell(R_W, AlignmentType.RIGHT, [t([e.dates, e.place].filter(Boolean).join("  |  "))]),
      ] })],
    }),
    // what the company is: one italic line under the job, not a bullet
    ...(e.about ? [new Paragraph({ spacing: { before: 0, after: 20, ...line(BODY) }, keepNext: true,
      children: [t(e.about, { italics: true, size: 20, color: "444444" })] })] : []),
    ...(e.bullets ?? []).map(bullet),
  ];

  // the contact line: only what's given, each with its icon (and a link)
  const c = cv.contact ?? {}, gap = "   ";
  const bits = [
    c.place && [img("pin"), t(`  ${c.place}`, { size: 19 })],
    c.email && [link(`mailto:${c.email}`, [img("mail"), t(`  ${c.email}`, { size: 19 })])],
    c.phone && [link(`tel:${c.phone.replace(/[^\d+]/g, "")}`, [img("phone"), t(`  ${c.phone}`, { size: 19 })])],
    c.github && [link(`https://${c.github.replace(/^https?:\/\//, "")}`, [img("github"), t(`  ${c.github.replace(/^https?:\/\/(www\.)?/, "")}`, { size: 19 })])],
    c.linkedin && [link(`https://www.${c.linkedin.replace(/^https?:\/\/(www\.)?/, "")}`, [img("linkedin"), t(`  ${c.linkedin.replace(/^https?:\/\/(www\.)?/, "")}`, { size: 19 })])],
  ].filter(Boolean);
  const contact = bits.flatMap((b, i) => (i ? [t(gap, { size: 19 }), ...b] : b));

  const out = [];
  for (const [lang, v] of Object.entries(cv.versions ?? {})) {
    const h = v.h ?? {};
    const doc = new Document({
      creator: cv.name, title: v.doctitle || cv.name,
      styles: { default: { document: { run: { font: FONT, size: 21 } } } },
      numbering: { config: [{ reference: "dots", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 380, hanging: 170 } }, run: { font: FONT } } }] }] },
      sections: [{
        properties: { page: { size: { width: W, height: H }, margin: { top: 680, bottom: 560, left: LEFT, right: RIGHT } } },
        children: [
          new Paragraph({ spacing: { after: 0, ...line(0.85) }, children: [t(cv.name, { bold: true, size: 50 })] }),
          ...(v.title ? [new Paragraph({ spacing: { after: 160, ...line(0.85) }, children: [t(v.title, { italics: true, size: 33 })] })] : []),
          ...(contact.length ? [new Paragraph({ spacing: { after: 60, ...line(0.7) }, children: contact })] : []),
          ...(v.profile ? [heading(h.profile ?? "Profile"), new Paragraph({ spacing: { before: 0, after: 0, ...line(BODY) }, children: rich(v.profile) })] : []),
          ...(v.jobs?.length ? [heading(h.work ?? "Work Experience"), ...v.jobs.flatMap((e, i) => entry(e, i === 0))] : []),
          ...(v.edu?.length ? [heading(h.edu ?? "Education"), ...v.edu.flatMap((e, i) => entry(e, i === 0))] : []),
          ...(v.skills?.length ? [heading(h.skills ?? "Skills"), ...v.skills.map(([k, s], i) => new Paragraph({
            spacing: { before: 0, after: i === v.skills.length - 1 ? 0 : 40, ...line(BODY) }, children: [t(`${k} `, { bold: true }), t(s)] }))] : []),
          ...(v.langs?.length ? [heading(h.langs ?? "Languages"), new Paragraph({ spacing: { after: 0, ...line(BODY) },
            children: v.langs.flatMap(([k, s], i) => [t(`${k} `, { bold: true }), t(s + (i < v.langs.length - 1 ? ", " : ""))]) })] : []),
        ],
      }],
    });
    out.push({ lang, data: await Packer.toBuffer(doc) });
  }
  return out;
}
