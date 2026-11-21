// The CV builder: a .json in, one .docx per language out, with what's given.
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { buildCv } from "../scripts/cv-build.mjs";

let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ✓", name); };

// the text of word/document.xml in a .docx (a zip)
function documentXml(buf) {
  for (let i = 0; i < buf.length - 30; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(i + 8), size = buf.readUInt32LE(i + 18), n = buf.readUInt16LE(i + 26), extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + n).toString();
    if (name !== "word/document.xml") continue;
    const data = buf.subarray(i + 30 + n + extra, i + 30 + n + extra + size);
    return (method === 8 ? inflateRawSync(data) : data).toString();
  }
  throw new Error("no word/document.xml");
}
const text = (xml) => xml.replace(/<[^>]+>/g, "");

const CV = {
  name: "Alex Example",
  contact: { place: "Leipzig", email: "alex@example.com", linkedin: "linkedin.com/in/alex-example" },
  versions: {
    de: { title: "Data Analyst · Werkstudent", h: { profile: "Profil", work: "Berufserfahrung", edu: "Ausbildung", skills: "Kenntnisse", langs: "Sprachen" },
      profile: "Zwei Jahre SQL und Power BI.",
      jobs: [{ title: "Data Analyst", org: "Example GmbH", dates: "01/2024 – 10/2026", place: "Leipzig", about: "Ein Online-Shop",
        bullets: ["Berichte mit **SQL** gebaut: **50 % schneller**"] }],
      edu: [{ title: "M.Sc. Data Science", org: "Universität Leipzig", dates: "10/2026 – heute", place: "Leipzig", bullets: [] }],
      skills: [["Daten:", "SQL, Power BI"]], langs: [["Deutsch:", "B2"], ["Englisch:", "C1"]] },
    en: { title: "Data Analyst · Working Student", profile: "Two years of SQL and Power BI.", jobs: [], edu: [], skills: [], langs: [] },
  },
};

const out = await buildCv(CV);
const de = documentXml(out.find((o) => o.lang === "de").data);
await ok("one .docx per language", () => assert.deepEqual(out.map((o) => o.lang), ["de", "en"]));
await ok("the name, the title, the headings and the bullets are in it", () => {
  for (const s of ["Alex Example", "Data Analyst · Werkstudent", "Berufserfahrung", "Ein Online-Shop", "01/2024 – 10/2026  |  Leipzig", "Deutsch: B2, Englisch: C1"])
    assert.ok(text(de).includes(s), s);
});
await ok("**…** in a bullet is bold, and only that", () => {
  assert.match(de, /<w:b\/>[\s\S]{0,400}?<w:t[^>]*>SQL<\/w:t>/);
  assert.ok(!text(de).includes("**"));
});
await ok("the contact line has only what's given, with links", () => {
  assert.ok(text(de).includes("alex@example.com") && text(de).includes("linkedin.com/in/alex-example"));
  assert.ok(!/github/.test(text(de)), "no GitHub given, none shown");
});
await ok("a language with no jobs, schooling, skills or languages leaves those sections out", () => {
  const en = text(documentXml(out.find((o) => o.lang === "en").data));
  assert.ok(en.includes("Two years of SQL"));
  for (const h of ["Work Experience", "Education", "Skills", "Languages"]) assert.ok(!en.includes(h), h);
});

// ---------------------------------------------------------------- the PDF the bot draws
const { cvPdf } = await import("../src/cvpdf.ts");
const { CV_FONTS } = await import("../src/cvassets.ts");
const { fit } = await import("../src/cv.ts");
// the text a PDF reader gets: each <glyphs> Tj mapped back through the font's table
const reverse = Object.fromEntries(Object.values(CV_FONTS).flatMap((f) => f.table.split(",").map((e) => e.split(":").map(Number)).map(([c, g]) => [`${f.name}:${g}`, c])));
function pdfText(pdf) {
  const s = new TextDecoder("latin1").decode(pdf);
  const keys = { F1: "Amiri-Regular", F2: "Amiri-Bold", F3: "Amiri-Italic" };
  return [...s.matchAll(/\/(F\d) [\d.]+ Tf [\d.-]+ [\d.-]+ Td <([0-9a-f]+)> Tj/g)]
    .map(([, f, hex]) => hex.match(/.{4}/g).map((h) => String.fromCodePoint(reverse[`${keys[f]}:${parseInt(h, 16)}`] ?? 63)).join("")).join(" ");
}
const BASE = { ...CV, versions: { de: CV.versions.de } };
const drawn = cvPdf(BASE, BASE.versions.de, "de");
await ok("the bot's PDF: one page, the font in it with its ToUnicode map, links on the contact line", () => {
  const s = new TextDecoder("latin1").decode(drawn.pdf);
  assert.ok(s.startsWith("%PDF-1.7")); assert.equal(drawn.overflow, 0);
  assert.match(s, /\/Count 1/); assert.match(s, /\/FontFile2/); assert.match(s, /\/ToUnicode/);
  assert.match(s, /\/URI \(mailto:alex@example\.com\)/); assert.match(s, /\/URI \(https:\/\/www\.linkedin\.com\/in\/alex-example\/\)/);
});
await ok("…and its text reads back: the name, a heading, a bullet with its bold part, umlauts", () => {
  const t = pdfText(drawn.pdf);
  for (const x of ["Alex Example", "Berufserfahrung", "Berichte mit ", "SQL", "50 % schneller", "Universität Leipzig"]) assert.ok(t.includes(x), x);
});
await ok("a CV too long for the page: the entry with the most bullets loses its last ones, never below two", () => {
  const long = JSON.parse(JSON.stringify(BASE.versions.de));
  long.jobs[0].bullets = Array.from({ length: 60 }, (_, i) => `Punkt ${i + 1}: eine Zeile, die etwas Platz braucht`);
  assert.ok(cvPdf(BASE, long, "de", true).overflow > 0);
  const short = fit(long, (v) => cvPdf(BASE, v, "de", true).overflow > 0);
  assert.ok(short.jobs[0].bullets.length < 60 && short.jobs[0].bullets.length >= 2);
});
await ok("a long contact line gets smaller to fit, and a long company line wraps: nothing past the right margin", () => {
  const long = { ...BASE, contact: { place: "Berlin", email: "someone.with.a.long.name@example.com", phone: "+49 151 41319788",
    github: "github.com/SomeoneWithAVeryLongName", linkedin: "linkedin.com/in/someone-with-a-very-long-name" } };
  const v = JSON.parse(JSON.stringify(long.versions.de));
  v.jobs[0].about = "Ein sehr langer Satz darüber, was diese Firma macht, mit vielen Produkten, Märkten, Kunden und noch mehr Wörtern, die nicht in eine Zeile passen";
  const s = new TextDecoder("latin1").decode(cvPdf(long, v, "de").pdf);
  const runs = [...s.matchAll(/\/(F\d) ([\d.]+) Tf ([\d.-]+) ([\d.-]+) Td <([0-9a-f]+)> Tj/g)];
  const keys = { F1: "Regular", F2: "Bold", F3: "Italic" };
  const widths = Object.fromEntries(Object.entries(CV_FONTS).map(([k, f]) => [k, Object.fromEntries(f.table.split(",").map((e) => e.split(":").map(Number)).map(([, g, w]) => [g, w]))]));
  const right = Math.max(...runs.map(([, f, size, x, , hex]) => Number(x) + hex.match(/.{4}/g).reduce((a, h) => a + (widths[keys[f]][parseInt(h, 16)] ?? 500), 0) * Number(size) / 1000));
  assert.ok(right <= 547.5, `text reaches ${right.toFixed(1)} pt, the margin is 547`);
  const italicLines = new Set(runs.filter(([, f]) => f === "F3").map(([, , , , y]) => y));
  assert.ok(italicLines.size >= 3, "the company line wrapped onto a second line");
});
await ok("fast enough for a Worker's 10 ms: a PDF in well under 5 ms once warm", () => {
  for (let i = 0; i < 5; i++) cvPdf(BASE, BASE.versions.de, "de");
  const t = process.cpuUsage();
  for (let i = 0; i < 20; i++) cvPdf(BASE, BASE.versions.de, "de");
  const u = process.cpuUsage(t);
  assert.ok((u.user + u.system) / 20 / 1000 < 5, `${((u.user + u.system) / 20 / 1000).toFixed(2)} ms`);
});

console.log(`\nall ${pass} cv checks passed`);
