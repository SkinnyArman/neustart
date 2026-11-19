// npm run cv - the CVs in ../cv/ into the bot's database, where it can read
// and tweak them. The folder is gitignored: CVs are personal.
//
// Per person (the id from neustart.yaml, e.g. "alex"), either or both of:
//   cv/alex.json           the CV's content, per language (see cv-build.mjs):
//                          it's built into cv/alex-de.docx, cv/alex-en.docx, …
//   cv/alex-<name>.docx    your own Word files, stored as they are
// stored in the kv table as
//   cv_content:alex        the .json, as text
//   cv_docx:alex:<name>    each .docx, base64 (name: "de", "en", …)
//   cv_files:alex          what's there, with sizes and the date
//
//   npm run cv                     everyone with files in cv/
//   npm run cv -- alex             only alex
//   npm run cv -- --no-build       store the .docx as they are, don't build from the .json
//   npm run cv -- --build-only     only build the .docx, store nothing
//   npm run cv -- --local          the local database (wrangler dev)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CF, ROOT, dbName, kvSql, readConfigFile, wrangler } from "./lib.mjs";
import { buildCv } from "./cv-build.mjs";

const args = process.argv.slice(2);
const DIR = resolve(ROOT, "cv");
if (!existsSync(DIR)) { console.error(`No ${DIR} folder: put the CVs there (see the top of scripts/cv.mjs).`); process.exit(1); }

// the people the config knows, to catch a misspelt file name
let known = null;
try { known = (readConfigFile().jobs?.people ?? []).map((p) => p.id).filter(Boolean); } catch { /* no config: don't check */ }

const files = () => readdirSync(DIR);
const ids = args.filter((a) => !a.startsWith("--"));
const people = ids.length ? ids
  : [...new Set(files().filter((f) => /^[a-z0-9_]+(\.json|-[\w-]+\.docx)$/.test(f)).map((f) => f.split(/[.-]/)[0]))];
if (!people.length) { console.error(`Nothing in ${DIR}: expected <id>.json and/or <id>-<name>.docx.`); process.exit(1); }

let sql = "";
for (const id of people) {
  if (!/^[a-z0-9_]+$/.test(id)) { console.error(`"${id}" isn't a person id`); process.exit(1); }
  if (known && !known.includes(id)) console.warn(`⚠️  ${id} isn't one of the people in neustart.yaml (${known.join(", ")}) - stored anyway`);
  const list = [];
  const json = resolve(DIR, `${id}.json`);
  if (existsSync(json)) {
    const text = readFileSync(json, "utf8");
    let cv;
    try { cv = JSON.parse(text); } catch (e) { console.error(`${id}.json: ${e.message}`); process.exit(1); }
    if (!args.includes("--no-build")) {
      for (const { lang, data } of await buildCv(cv)) writeFileSync(resolve(DIR, `${id}-${lang}.docx`), data);
    }
    sql += kvSql(`cv_content:${id}`, text);
    list.push({ name: "content", file: `${id}.json`, bytes: text.length });
  }
  // a language or file taken out of cv/ goes from the bot too
  sql += `DELETE FROM kv WHERE k LIKE 'cv\\_docx:${id}:%' ESCAPE '\\';\n`;
  for (const f of files().filter((f) => f.startsWith(`${id}-`) && f.endsWith(".docx"))) {
    const bytes = readFileSync(resolve(DIR, f));
    const name = f.slice(id.length + 1, -".docx".length);
    sql += kvSql(`cv_docx:${id}:${name}`, bytes.toString("base64"));
    list.push({ name, file: f, bytes: bytes.length });
  }
  if (!list.length) { console.error(`No files for ${id} in ${DIR}`); process.exit(1); }
  sql += kvSql(`cv_files:${id}`, JSON.stringify({ at: new Date().toISOString(), files: list }));
  console.log(`${id}: ${list.map((l) => `${l.file} (${Math.max(1, Math.round(l.bytes / 1024))} kB)`).join(", ")}`);
}
if (args.includes("--build-only")) process.exit(0);

writeFileSync(resolve(CF, "cv.sql"), sql);                    // gitignored
for (let i = 1; i <= 3; i++) {
  const r = wrangler(["d1", "execute", dbName(), args.includes("--local") ? "--local" : "--remote", "--file=cv.sql", "--yes"], { quiet: true });
  if (r.ok) { console.log("\nStored. The bot can read them now."); process.exit(0); }
  console.error(`try ${i}: ${r.out.slice(-300)}`);
}
process.exit(1);
