// Golden run: the whole bot, driven only through its entry points - the cron
// ticks (every trigger, minute by minute, over hours), the Telegram webhook
// (commands and button presses) and /health - against fake sites, a fake
// OpenAI and a fake Telegram. Everything the bot sends out (each search URL,
// each AI prompt, each Telegram message) and the database it leaves behind
// are recorded.
//
// test/golden.json was recorded from the code before the bot read its setup
// from a config. The same run must still give exactly that: the config in
// fixtures/config.mjs describes the same setup, so nothing may differ.
//
//   node test/golden.mjs            compare with test/golden.json
//   node test/golden.mjs record     write test/golden.json (only on purpose)
//
// The setup is seeded both ways: the old keys (profile, jobs_people, the
// TOPIC_* vars) and the new one (config). Each version reads only its own.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { PROFILE, PEOPLE, CONFIG, TOPICS_ENV } from "./fixtures/config.mjs";

const SRC = new URL("../src/", import.meta.url).pathname;
const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8").replace(/-- bike alerts[\s\S]*$/, "");
const GOLDEN = new URL("./golden.json", import.meta.url);
const RECORD = process.argv[2] === "record";
// --data <file.mjs>: the same run with other people's data (see golden-real in the README)
const DATA = process.argv.includes("--data") ? await import(new URL(process.argv[process.argv.indexOf("--data") + 1], `file://${process.cwd()}/`).href) : null;
const P = DATA ?? { PROFILE, PEOPLE, CONFIG, TOPICS_ENV };

// ---------------------------------------------------------------- clock
const START = Date.UTC(2026, 9, 27, 8, 0);            // Tue 27 Oct 2026, 08:00 UTC
let NOW = START;
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
}
globalThis.Date = FakeDate;
Math.random = () => 0.5;
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, 0, ...a);
console.log = () => {}; console.error = () => {};
const out = (...a) => process.stdout.write(a.join(" ") + "\n");

// ---------------------------------------------------------------- D1
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a.map((x) => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x)); return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
}
const makeDB = () => { const db = new DatabaseSync(":memory:"); db.exec(SCHEMA); return { prepare: (s) => new Stmt(db, s), raw: db }; };

// ---------------------------------------------------------------- the sites
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-|-$/g, "");
const kaCard = ([id, title, price, place, km, date]) =>
  `<article class="aditem" data-adid="${id}" data-href="/s-anzeige/${slug(title)}/${id}-1-7743">` +
  `<img class="i" src="https://img.kleinanzeigen.de/api/v1/prod-ads/images/aa/${id}?rule=$_2.AUTO">` +
  `<div><svg></svg><span>${place}</span><span class="k">(${km} km)</span></div>` +
  `<div><svg></svg><span>${date}</span></div>` +
  `<h3><a class="t" href="/s-anzeige/${slug(title)}/${id}-1-7743">${title}</a></h3>` +
  `<p class="mb-xsmall">Beschreibung zu ${title}, gut erhalten</p>${price === null ? "" : `<p class="text-title3 font-bold">${price}</p>`}</article>`;
const kaPage = (cards) => `<html><h1>Ergebnisse</h1>${cards.map(kaCard).join("")}${" ".repeat(3000)}</html>`;

const LISTINGS = {
  damen: kaPage([[101, "28 Damenrad Hollandrad", "20 € VB", "03048 Cottbus", 3, "Heute, 10:12"],
    [102, "Kinderfahrrad 20 Zoll", "15 €", "03044 Cottbus", 2, "Heute, 09:00"],
    [103, "Damen Fahrrad 28er", "30 €", "03149 Forst (Lausitz)", 21, "07.09.2026"]]),
  herren: kaPage([[201, "Herrenrad Pegasus 28", "25 €", "03042 Cottbus", 6, "Heute, 08:20"],
    [202, "Cratoni MTB Helm", "20 €", "03044 Cottbus", 2, "Heute, 08:00"]]),
  weiteres: kaPage([[301, "Rocky Mountain Bike 26 Zoll", "25 € VB", "03058 Neuhausen/Spree", 11, "Heute, 07:00"],
    [302, "Fahrrad 28 Zoll weit weg", "10 €", "01067 Dresden", 90, "Heute, 06:00"]]),
  betten: kaPage([[401, "IKEA Brimnes Bett 140x200 cm", "90 €", "03044 Cottbus", 2, "Heute, 11:00"],
    [402, "Bettgestell 160x200 Massivholz", "50 €", "03046 Cottbus", 1, "Heute, 10:00"],
    [403, "Doppelbett Holz mit Lattenrost", "80 €", "03050 Cottbus", 3, "Heute, 09:00"]]),
  kommode: kaPage([[501, "IKEA Malm Kommode 3 Schubladen", "30 €", "03046 Cottbus", 1, "Heute, 12:00"],
    [502, "Wickelkommode mit Auflage", "25 €", "03044 Cottbus", 2, "Heute, 11:30"]]),
  teppich: kaPage([[701, "Wohnzimmerteppich 160x230 cm", "25 €", "03044 Cottbus", 2, "Heute, 12:00"],
    [702, "Teppich beige", "15 €", "03050 Cottbus", 3, "Heute, 11:00"],
    [703, "Badematte 60x90", "5 €", "03046 Cottbus", 1, "Heute, 10:00"]]),
  free: kaPage([[601, "Verschiedenes zum Verschenken", null, "03050 Cottbus", 3, "Heute, 12:33"],
    [602, "diverse Teller, Tassen zu verschenken", null, "03229 Luckaitztal", 25, "Heute, 11:09"],
    [603, "Pflanzen zu verschenken", null, "03226 Vetschau", 19, "Heute, 06:45"],
    [604, "Teppich 200x300 zu verschenken", null, "03046 Cottbus", 1, "Heute, 05:30"],
    [605, "Klebetapete", null, "03046 Cottbus", 1, "Heute, 05:00"]]),
  wg: kaPage([[801, "WG-Zimmer 18 m² nahe BTU", "320 €", "03046 Cottbus", 1, "Heute, 09:30"],
    [802, "Zimmer in 3er WG, nur Frauen", "300 €", "03044 Cottbus", 2, "Heute, 09:00"],
    [803, "Helles Zimmer mit Balkon", "350 €", "03050 Cottbus", 3, "Heute, 08:00"]]),
};
const ART = { "ikea-brimnes-bett-140x200-cm": "Betten", "doppelbett-holz-mit-lattenrost": "Betten" };
const kaAd = (art, text) =>
  `<html><p id="viewad-description-text" class="x">${text}</p><ul>` +
  (art ? `<li class="addetailslist--detail">Art<span class="a">${art}</span></li>` : "") +
  `<li class="addetailslist--detail">Zustand<span class="a">In Ordnung</span></li>` +
  `<li class="addetailslist--detail">Verfügbar ab<span class="a">November 2026</span></li></ul></html>`;
const AD_TEXT = "Gebraucht, guter Zustand, alles funktioniert. Wir sind eine entspannte WG, kochen oft zusammen. Nur Abholung, bitte bis Ende der Woche melden.";

const wgCard = (id, title, rent, size) =>
  `<div id="liste-details-ad-${id}" data-id="${id}"><a href="/wg-zimmer-in-Cottbus-Mitte.${id}.html" title="Anzeige ansehen: ${title}">x</a>` +
  `<span title="3er WG (1w,1m,0d,1n)"></span><img src="/img/wgeg.gif"><b>${rent} €</b> <b>${size} m²</b>` +
  `<div class="col-xs-11 x">\n<span >3er WG | Cottbus Mitte | Sandower Str. 5</span></div></div>`;
const WG_LIST = `<html>${wgCard(9101, "Gemütliches Zimmer in Altbau-WG", 340, 16)}${wgCard(9102, "Zimmer frei in Sachsendorf", 280, 14)}</html>`;
const WG_AD = `<html><div id="ad_description_text"><p>Wir sind drei Studis, kochen gern zusammen und suchen jemanden Entspanntes. Das Zimmer ist ab 1.11. frei, 16 m², Altbau mit Dielen.</p></div>\n</div></html>`;

const baJob = (ref, title, firma, ort, art = "ARBEIT", vollzeit = false) => ({
  referenznummer: ref, stellenangebotsTitel: title, firma, stellenangebotsart: art, arbeitszeitVollzeit: vollzeit,
  homeofficemoeglich: true, stellenlokationen: [{ adresse: { ort } }],
});
const BA = [
  baJob("10001", "Werkstudent Data Analyst (m/w/d)", "Zalando SE", "Berlin", "PRAKTIKUM_TRAINEE"),
  baJob("10002", "Senior Data Scientist (m/w/d)", "Delivery Hero SE", "Berlin"),
  baJob("10004", "Werkstudent Frontend Entwicklung React (m/w/d)", "N26 GmbH", "Berlin", "PRAKTIKUM_TRAINEE"),
  baJob("10005", "Sachbearbeiter Buchhaltung (m/w/d)", "LEAG", "Cottbus"),
  baJob("10006", "Data Engineer (m/w/d) - Teilzeit", "Vattenfall GmbH", "Berlin", "ARBEIT", true),
  baJob("10008", "Junior Data Analyst (m/w/d)", "Siemens AG", "Berlin", "ARBEIT", true),
  baJob("10009", "Data Scientist (m/w/d)", "Statista GmbH", "Berlin"),
  baJob("10010", "Werkstudent Data Science (m/w/d)", "SAP SE", "Cottbus", "ARBEIT", true),
  baJob("10011", "Werkstudent Business Intelligence (m/w/d)", "Deutsche Bahn AG", "Cottbus", "PRAKTIKUM_TRAINEE"),
];
const ARBEITNOW = [
  { slug: "zalando-werkstudent-data-analyst", company_name: "Zalando", title: "Werkstudent Data Analyst (m/w/d)", description: "<p>Analyse</p>", remote: false, url: "https://arbeitnow.example/1", location: "Berlin", job_types: ["Student"] },
  { slug: "acme-working-student-ml", company_name: "Acme AI", title: "Working Student Machine Learning", description: "<p>Python, <b>English</b></p>", remote: true, url: "https://arbeitnow.example/2", location: "Remote", job_types: ["Student"] },
  { slug: "web-cottbus", company_name: "Lausitz Web", title: "Working Student Frontend (React)", description: "<p>React, TypeScript</p>", remote: false, url: "https://arbeitnow.example/3", location: "Cottbus", job_types: ["Student"] },
  { slug: "sales-hamburg", company_name: "X", title: "Sales Manager", description: "", remote: false, url: "u", location: "Hamburg", job_types: [] },
];
const casualAd = (ref, title, firma, ort = "Cottbus") => ({ referenznummer: ref, stellenangebotsTitel: title, firma, stellenangebotsart: "ARBEIT", stellenlokationen: [{ adresse: { ort } }] });
const CASUAL = [
  casualAd("20001", "Aushilfe im Verkauf (m/w/d)", "Engbers GmbH & Co KG"),
  casualAd("20002", "Minijob als Reinigungskraft (m/w/d)", "Clean GmbH"),
  casualAd("20003", "Minijob Ergotherapeut/in Cottbus", "Praxis Weiß"),
  casualAd("20005", "Tourenfahrer Cottbus (m/w/d) - Vollzeit", "Kurier AG"),
  casualAd("20007", "Minijob - Zeitung austragen in Kolkwitz", "Zeitung GmbH", "Kolkwitz"),
];
const CASUAL_DETAILS = {
  "20001": { stellenangebotsBeschreibung: "<p>**Wir sind** ein Modehaus. " + "Wir wachsen. ".repeat(20) + "</p><h2>## Deine Aufgaben</h2><p>* Kasse</p><p>- Beratung</p>", verguetungsangabe: "STUNDENLOHN", festgehalt: 15, arbeitszeitTeilzeitVormittag: true, eintrittszeitraum: { von: "2026-11-01" }, externeURL: "https://engbers.example/apply" },
  "20002": { stellenangebotsBeschreibung: "Reinigung von Büros, 14,50 € pro Stunde.", verguetungsangabe: "KEINE_ANGABEN", arbeitszeitTeilzeitFlexibel: true },
  "20007": { stellenangebotsBeschreibung: "Zeitung austragen, Minijob 603 € Basis.", verguetungsangabe: "KEINE_ANGABEN" },
};

// ---------------------------------------------------------------- fake network
const TRACE = [];
const mark = (step) => TRACE.push({ step });
const net = { ai: "ok", ka: "ok", msg: 1000 };
const b64dec = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const ok = (o) => new Response(JSON.stringify({ choices: [{ message: { content: typeof o === "string" ? o : JSON.stringify(o) } }] }));

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  let body = init.body ?? null;
  try { body = body && JSON.parse(body); } catch { /* text */ }
  const entry = { url };
  if (init.method && init.method !== "GET") entry.method = init.method;
  if (body) entry.body = body;
  const cookie = init.headers?.Cookie; if (cookie) entry.cookie = cookie;
  TRACE.push(entry);

  if (url.includes("wg-gesucht.de")) {
    if (/\.\d+\.html$/.test(url) && !/wg-zimmer-in-\w+\.\d+\.0\.1\.0\.html/.test(url)) return new Response(WG_AD);
    return new Response(url.includes("Cottbus") ? WG_LIST : "<html>keine Ergebnisse</html>", { headers: { "set-cookie": "PHPSESSID=wg1; Path=/" } });
  }
  if (url.includes("kleinanzeigen.de")) {
    if (net.ka === "block") return new Response("Access denied", { status: 403 });
    if (url.includes("/s-anzeige/")) {
      const s = url.split("/s-anzeige/")[1].split("/")[0];
      return new Response(kaAd(ART[s] ?? (/(rad|bike|fahrrad)/i.test(s) ? "Damen" : null), AD_TEXT));
    }
    const key = url.includes("/s-auf-zeit-wg/") ? "wg" : url.includes("/kommode/") ? "kommode" : url.includes("/teppich/") ? "teppich"
      : url.includes("/s-zu-verschenken/") ? "free" : (/art_s:(\w+)/.exec(url)?.[1] ?? "");
    assert.ok(LISTINGS[key], "unexpected Kleinanzeigen listing: " + url);
    return new Response(LISTINGS[key], { headers: { "set-cookie": "sess=ka1; Path=/" } });
  }
  if (url.includes("arbeitsagentur.de")) {
    if (url.includes("/jobdetails/")) {
      const ref = b64dec(url.split("/").pop());
      if (CASUAL_DETAILS[ref]) return Response.json(CASUAL_DETAILS[ref]);
      if (ref.startsWith("2")) return new Response("gone", { status: 404 });
      return Response.json({ stellenangebotsBeschreibung: `Aufgaben bei ${ref}: SQL, Python, Dashboards mit Tableau. Deutsch B2. 20 Std./Woche.`, externeURL: "https://apply.example/" + ref });
    }
    const q = new URL(url).searchParams;
    return Response.json({ ergebnisliste: q.get("arbeitszeit") === "mj" ? CASUAL : BA });
  }
  if (url.includes("arbeitnow.com")) return Response.json({ data: ARBEITNOW });
  if (url.includes("api.openai.com/v1/models/")) return new Response("{}", { status: net.ai === "401" ? 401 : 200 });
  if (url.includes("api.openai.com")) {
    if (net.ai === "401") return new Response('{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}', { status: 401 });
    const sys = body.messages[0].content, user = body.messages[1].content;
    const title = /Title: (.*)/.exec(user)?.[1] ?? "";
    if (/cover letter/.test(sys)) return ok("Sehr geehrte Damen und Herren — Ihr Dashboard-Team … Mit freundlichen Grüßen");
    if (/match German job ads/.test(sys)) {
      return ok(/Senior|Statista/.test(title) ? { for: "none", reason: /Statista/.test(title) ? "full-time" : "too senior" }
        : /Frontend|React/.test(title) ? { for: "arman", kind: "werkstudent", why: "React work fits", gaps: [], german: "B2", hours: "20 h/week", start: "asap", deadline: "", lang: "de", skills: ["React", "TypeScript"] }
        : /Business Intelligence/.test(title) ? { for: "both", kind: "werkstudent", why: "BI and dashboards for both", gaps: ["Tableau - mention Power BI"], german: "C1", hours: "", start: "", deadline: "01.12.", lang: "de", skills: ["SQL", "Tableau"] }
        : /Data Engineer/.test(title) ? { for: "diba", kind: "part-time", why: "SQL pipelines", gaps: ["Airflow"], german: "C1", hours: "20 h", start: "", deadline: "30.11.", lang: "de", skills: ["Airflow", "SQL", "Tableau"] }
        : { for: "diba", kind: "werkstudent", why: "Dashboards and SQL fit", gaps: ["Tableau - mention Power BI"], german: "B2", hours: "20 h/week", start: "asap", deadline: "15.11.", lang: /Working Student/.test(title) ? "en" : "de", skills: ["SQL", "Python", "Tableau"] });
    }
    if (/screen free giveaway ads/.test(sys)) {
      const ads = [...user.matchAll(/id: (\S+)\ntitle: (.*)/g)].map(([, id, t]) => ({ id, score: /Verschiedenes/.test(t) ? 6 : 1, reason: "test" }));
      return ok({ ads });
    }
    if (/You rate second-hand/.test(sys)) {
      return ok(/Doppelbett/.test(title) ? { is_match: true, kind: "Wooden double bed", score: 6, why: "Cheap, size unknown", notes: ["Size not stated - ask"] }
        : /Teppich beige/.test(title) ? { is_match: true, kind: "Area rug", score: 6, why: "Cheap", notes: ["Size not stated - ask", "3 km from Cottbus"] }
        : /Verschiedenes/.test(title) ? { is_match: false, reason: "just clothes" }
        : { is_match: true, kind: "Good find", score: 7, why: "Well kept and close", notes: ["Pickup only"] });
    }
    return ok({ language: "de", ad_summary: "Room", facts_used: [], thin_ad: false, message: "Hallo zusammen, ich bin Max!" });
  }
  if (url.includes("api.telegram.org")) return Response.json({ ok: true, result: { message_id: ++net.msg } });
  throw new Error("unexpected fetch " + url);
};

const { Store } = await import(SRC + "store.ts");
const worker = (await import(SRC + "index.ts")).default;

// ---------------------------------------------------------------- driving it
const ENV = (DB) => ({ DB, OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-5.6-terra", FINDS_MODEL: "gpt-5.6-luna",
  TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "-1001234567890", TELEGRAM_OWNER_ID: "1000001", WEBHOOK_SECRET: "s", ...P.TOPICS_ENV });
const GROUP = -1001234567890, OWNER = 1000001, FRIEND = 2000002;

async function seed(DB, active) {
  const st = new Store(DB);
  await st.kvSet("profile", JSON.stringify(P.PROFILE));             // old: the room profile
  await st.kvSet("jobs_people", JSON.stringify(P.PEOPLE));          // old: the job seekers
  await st.kvSet("config", JSON.stringify(P.CONFIG));               // new: everything
  if (active) await st.kvSet("jobs_active", active);
  return st;
}
const result = async (r) => ({ status: r.status, text: await r.text() });
async function tick(E, cron) {
  const waits = [];
  await worker.scheduled({ cron, scheduledTime: NOW }, E, { waitUntil: (p) => waits.push(p) });
  await Promise.allSettled(waits);
}
/** Every trigger that fires in the next `minutes`, in order, like Cloudflare does. */
async function run(E, minutes) {
  for (let i = 0; i < minutes; i++) {
    NOW += 60_000;
    const m = new Date(NOW).getUTCMinutes();
    if (m % 2 === 0) { mark(`tick wg ${m}`); await tick(E, "*/2 * * * *"); }
    if (m % 10 === 5) { mark(`tick finds ${m}`); await tick(E, "5,15,25,35,45,55 * * * *"); }
    if (m % 10 === 3) { mark(`tick jobs ${m}`); await tick(E, "3,13,23,33,43,53 * * * *"); }
    if (m % 10 === 7) { mark(`tick casual ${m}`); await tick(E, "7,17,27,37,47,57 * * * *"); }
  }
}
const post = (E, update, secret = "s") => worker.fetch(new Request("https://w/", { method: "POST",
  headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" }, body: JSON.stringify(update) }), E);
const msg = (text, { from = OWNER, chat = GROUP, thread = 965, extra = {} } = {}) =>
  ({ message: { text, from: { id: from }, chat: { id: chat }, ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}), ...extra } });
async function say(E, label, text, o) { mark(`say ${label}: ${text}`); TRACE.push({ res: await result(await post(E, msg(text, o))) }); }
async function press(E, data, { from = OWNER, chat = GROUP, message_id = 7, text } = {}) {
  mark(`press ${data}`);
  TRACE.push({ res: await result(await post(E, { callback_query: { id: "q", data, from: { id: from },
    message: { chat: { id: chat }, message_id, ...(text ? { text } : {}) } } })) });
}
const rows = (DB, sql) => DB.raw.prepare(sql).all();

function dump(DB) {
  const out = {};
  for (const { name } of rows(DB, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")) {
    const r = rows(DB, `SELECT * FROM ${name}`);
    const key = name === "kv" ? "k" : name === "ads" || name === "bikes" ? "ad_id" : "id";
    out[name] = r.filter((x) => !(name === "kv" && ["config", "profile", "jobs_people"].includes(x.k)))
      .sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  }
  return out;
}

// ---------------------------------------------------------------- the run
const DB = makeDB(); const E = ENV(DB);
const st = await seed(DB, "diba,arman");

mark("health");
for (const u of ["https://w/health", "https://w/health?ai", "https://w/"]) TRACE.push({ res: await result(await worker.fetch(new Request(u), E)) });
TRACE.push({ res: await result(await post(E, msg("/status"), "wrong")) });

await say(E, "owner private", "/start", { chat: OWNER, thread: null });
await say(E, "stranger", "/status", { from: FRIEND, thread: 597 });
await say(E, "stranger private", "/jobs", { from: FRIEND, chat: FRIEND, thread: null });
await say(E, "stranger", "/finds", { from: FRIEND, thread: 595 });
await say(E, "chatter", "hallo zusammen", { from: FRIEND });

// three hours of every trigger
await run(E, 180);

// the room search: draft, rewrite, approve, skip
const ads = rows(DB, "SELECT ad_id FROM ads WHERE status='pending' ORDER BY ad_id").map((r) => r.ad_id);
if (ads[0]) { await press(E, `dr:${ads[0]}`); await press(E, `re:${ads[0]}`); await press(E, `ok:${ads[0]}`, { text: "Hallo zusammen" }); }
if (ads[1]) await press(E, `no:${ads[1]}`);
await press(E, "dr:unknown");
await say(E, "owner", "/review", { thread: 597 });
const pending = rows(DB, "SELECT ad_id FROM ads WHERE status='pending' ORDER BY ad_id").map((r) => r.ad_id);
if (pending[0]) { await press(E, `rv:later:${pending[0]}`); await press(E, `rv:ok:${pending[0]}`); }
await press(E, "rv:stop:x");

// the finds card
await say(E, "group", "/finds", { from: FRIEND, thread: 595 });
for (const d of ["bk:price:bed:+10", "bk:off:carpet", "bk:on:carpet", "bk:min:+1", "bk:min:-1", "bk:price:free:+1", "bk:price:-5", "bk:now", "bk:noop"])
  await press(E, d, { from: FRIEND });
for (const t of ["/finds bed 80", "/finds kommode off", "/finds kommode on", "/finds carpet 30", "/finds min 5", "/finds min 0", "/finds free 7", "/finds now", "/finds xyz", "/bikes price 25", "/bikes off", "/bikes on"])
  await say(E, "group", t, { from: FRIEND, thread: 595 });

// the jobs: every button, every command
const job = (q) => rows(DB, `SELECT id FROM jobs WHERE ${q} ORDER BY id`).map((r) => r.id);
const posted = job("status='posted'");
const both = job("status='posted' AND person='both'");
const dibas = job("status='posted' AND person='diba'");
if (dibas[0]) { await press(E, `jb:letter:diba:${dibas[0]}`, { from: FRIEND }); await press(E, `jb:applied:diba:${dibas[0]}`, { from: FRIEND }); await press(E, `jb:interview:-:${dibas[0]}`); }
if (dibas[1]) { await press(E, `jb:already:diba:${dibas[1]}`); await press(E, `jb:rejected:-:${dibas[1]}`); }
if (both[0]) { await press(E, `jb:letter:arman:${both[0]}`); await press(E, `jb:applied:arman:${both[0]}`); }
const left = posted.filter((id) => ![dibas[0], dibas[1], both[0]].includes(id));
if (left[0]) await press(E, `jb:skip:-:${left[0]}`);
await press(E, "jb:applied:diba:nope");
for (const t of ["/jobs", "/skills", "/skills diba", "/skills diba + Tableau", "/skills diba - Tableau", "/skills arman + Vue", "/jobreport", "/cv", "/cv diba"])
  await say(E, "group", t, { from: FRIEND });
await say(E, "group", "/cv diba", { from: FRIEND, extra: { reply_to_message: { document: { file_id: "FILE-D" } } } });
mark("caption cv"); TRACE.push({ res: await result(await post(E, { message: { caption: "/cv arman", document: { file_id: "FILE-A" }, from: { id: FRIEND }, chat: { id: GROUP }, message_thread_id: 965, is_topic_message: true } })) });
await say(E, "group", "/cv", { from: FRIEND });
mark("caption cv, no name"); TRACE.push({ res: await result(await post(E, { message: { caption: "/cv", document: { file_id: "FILE-X" }, from: { id: FRIEND }, chat: { id: GROUP }, message_thread_id: 965, is_topic_message: true } })) });
await say(E, "group", "/cv arman", { from: FRIEND });
if (dibas[2]) await press(E, `jb:letter:diba:${dibas[2]}`, { from: FRIEND });

// every owner command
for (const t of ["/status", "/help", "/filters", "/filters max_rent 550", "/settings", "/settings hot_minutes 20", "/settings nope 1",
  "/stats", "/pause 2h", "/pause banana", "/scan", "/start", "/more 1", "/retry", "/resume", "/unknown"])
  await say(E, "owner", t, { thread: 597 });
for (const d of ["set:hot_minutes:+5", "set:pause", "set:resume", "flt:skip_pendler", "flt:max_rent:-50", "set:noop"]) await press(E, d);

// two more hours: what the changes did
await run(E, 120);

// a re-post, then a re-check
await st.kvSet("jobs_repost", "1"); await run(E, 20);
await st.kvSet("jobs_repost", "recheck"); await run(E, 40);

// twelve days later, a Monday: reminders and the weekly report
NOW = Date.UTC(2026, 10, 9, 6, 50);
await run(E, 80);
await say(E, "group", "/jobs", { from: FRIEND });

// OpenAI rejects the key while new jobs and ads come in, then Kleinanzeigen blocks
BA.push(baJob("10012", "Werkstudent Data Analytics (m/w/d)", "BASF SE", "Berlin", "PRAKTIKUM_TRAINEE"));
LISTINGS.betten = kaPage([[404, "Malm Bett 140x200 weiß", "40 €", "03046 Cottbus", 1, "Heute, 07:00"]]);
for (const k of ["bed", "damen"]) await st.kvSet("bikes_checked:" + k, "0");
net.ai = "401"; await run(E, 30); net.ai = "ok";
TRACE.push({ res: await result(await worker.fetch(new Request("https://w/health?ai"), E)) });
net.ka = "block"; await run(E, 30); net.ka = "ok";
await run(E, 30);
const dump1 = dump(DB);

// ---------------------------------------------------------------- only Diba searching
mark("--- second bot: only diba searching ---");
NOW = START;
const DB2 = makeDB(); const E2 = ENV(DB2);
await seed(DB2, "diba");
await run(E2, 90);
await say(E2, "group", "/jobs", { from: FRIEND });
await say(E2, "group", "/jobreport", { from: FRIEND });
const dump2 = dump(DB2);

// ---------------------------------------------------------------- nobody chosen
// No jobs_active: before, the code's own default (Diba); now, whoever the
// config doesn't mark active: false.
mark("--- third bot: jobs_active never set ---");
NOW = START;
const DB3 = makeDB(); const E3 = ENV(DB3);
await seed(DB3, null);
await run(E3, 60);
await say(E3, "group", "/jobs", { from: FRIEND });
const dump3 = dump(DB3);

// ---------------------------------------------------------------- compare
const got = JSON.parse(JSON.stringify({ trace: TRACE, db: dump1, db2: dump2, db3: dump3 }));
const file = DATA ? new URL(process.argv[process.argv.indexOf("--golden") + 1] ?? "./golden-real.json", `file://${process.cwd()}/`) : GOLDEN;
if (RECORD) {
  writeFileSync(file, JSON.stringify(got, null, 1));
  out(`recorded ${TRACE.length} events (${TRACE.filter((t) => t.url).length} requests) to ${file.pathname}`);
} else {
  const want = JSON.parse(readFileSync(file, "utf8"));
  const a = want.trace, b = got.trace;
  let diffs = 0;
  for (let i = 0; i < Math.max(a.length, b.length) && diffs < 5; i++) {
    const x = JSON.stringify(a[i]), y = JSON.stringify(b[i]);
    if (x !== y) {
      diffs++;
      const last = [...a.slice(0, i)].reverse().find((t) => t.step)?.step;
      out(`\n✗ event ${i} differs (after "${last}")\n  golden: ${x?.slice(0, 1500)}\n  now:    ${y?.slice(0, 1500)}`);
    }
  }
  for (const k of ["db", "db2", "db3"]) {
    for (const t of new Set([...Object.keys(want[k]), ...Object.keys(got[k])])) {
      if (JSON.stringify(want[k][t]) === JSON.stringify(got[k][t])) continue;
      diffs++;
      const w = want[k][t] ?? [], g = got[k][t] ?? [];
      const i = w.findIndex((r, j) => JSON.stringify(r) !== JSON.stringify(g[j]));
      out(`\n✗ ${k}.${t} differs at row ${i}\n  golden: ${JSON.stringify(w[i])?.slice(0, 800)}\n  now:    ${JSON.stringify(g[i])?.slice(0, 800)}`);
    }
  }
  if (diffs) { out(`\ngolden run: ${diffs} difference(s)`); process.exit(1); }
  out(`golden run: identical (${TRACE.length} events, ${TRACE.filter((t) => t.url).length} requests, ${["db", "db2", "db3"].reduce((n, k) => n + Object.values(got[k]).flat().length, 0)} rows)`);
}
