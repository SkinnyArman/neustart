// Offline tests for src/jobs.ts and its wiring. Synthetic Jobbörse and
// Arbeitnow answers, an in-memory D1, recorded OpenAI and Telegram calls.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { CONFIG } from "./fixtures/config.mjs";

const SRC = new URL("../src/", import.meta.url).pathname;
const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8").replace(/-- bike alerts[\s\S]*$/, "");

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a.map((x) => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x)); return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
}
const makeDB = () => { const db = new DatabaseSync(":memory:"); db.exec(SCHEMA); return { prepare: (s) => new Stmt(db, s), raw: db }; };

// ---------------------------------------------------------------- fixtures
const baJob = (ref, title, firma, ort, art = "ARBEIT", vollzeit = false) => ({
  referenznummer: ref, stellenangebotsTitel: title, firma, stellenangebotsart: art, arbeitszeitVollzeit: vollzeit,
  homeofficemoeglich: true, stellenlokationen: [{ adresse: { ort } }],
});
const BA_RESULTS = [
  baJob("10001", "Werkstudent Data Analyst (m/w/d)", "Zalando SE", "Berlin", "PRAKTIKUM_TRAINEE"),
  baJob("10002", "Senior Data Scientist (m/w/d)", "Delivery Hero SE", "Berlin"),
  baJob("10003", "Ausbildung Fachinformatiker Daten- und Prozessanalyse", "Stadtwerke Cottbus", "Cottbus", "AUSBILDUNG"),
  baJob("10004", "Werkstudent Frontend Entwicklung React (m/w/d)", "N26 GmbH", "Berlin", "PRAKTIKUM_TRAINEE"),
  baJob("10005", "Sachbearbeiter Buchhaltung (m/w/d)", "LEAG", "Cottbus"),
  baJob("10006", "Data Engineer (m/w/d) - Teilzeit", "Vattenfall GmbH", "Berlin", "ARBEIT", true),   // full-time listing, part-time title: kept
  baJob("10008", "Junior Data Analyst (m/w/d)", "Siemens AG", "Berlin", "ARBEIT", true),                // full-time: dropped by rule
  baJob("10009", "Data Scientist (m/w/d)", "Statista GmbH", "Berlin"),                                  // AI: full-time
  baJob("10010", "Werkstudent Data Science (m/w/d)", "SAP SE", "Berlin", "ARBEIT", true),               // student title wins
  baJob("10007", "Werkstudent Marketing Analytics (m/w/d)", "HelloFresh SE", "Berlin", "PRAKTIKUM_TRAINEE"),   // AI: none
];
const ARBEITNOW = [
  { slug: "zalando-werkstudent-data-analyst", company_name: "Zalando", title: "Werkstudent Data Analyst (m/w/d)",   // same job again
    description: "<p>Analyse</p>", remote: false, url: "https://arbeitnow.example/1", location: "Berlin", job_types: ["Student"] },
  { slug: "acme-working-student-ml", company_name: "Acme AI", title: "Working Student Machine Learning",
    description: "<p>Python, PyTorch, <b>English</b></p>", remote: true, url: "https://arbeitnow.example/2", location: "Remote", job_types: ["Student"] },
  { slug: "sales-hamburg", company_name: "X", title: "Sales Manager", description: "", remote: false, url: "u", location: "Hamburg", job_types: [] },
];
const PEOPLE = {
  diba: { name: "Diba Test", summary: "Data scientist, MDS student", skills: ["Python", "SQL", "Power BI"], cv: "Diba CV: two data jobs, SQL -50% reporting time." },
  arman: { name: "Arman Test", summary: "Frontend developer", skills: ["React", "React Native"], cv: "Arman CV: React Native app." },
};

// ---------------------------------------------------------------- network
const net = { ai: "ok", calls: [], tg: [], ba: 0, an: 0, details: 0, letters: [] };
let msgId = 100;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("arbeitsagentur.de")) {
    if (url.includes("/jobdetails/")) {
      net.details++;
      return Response.json({ stellenangebotsBeschreibung: "Aufgaben: SQL, Python, Dashboards mit Tableau. Deutsch B2. 20 Std./Woche.", externeURL: "https://apply.example" });
    }
    net.ba++;
    return Response.json({ ergebnisliste: BA_RESULTS, maxErgebnisse: BA_RESULTS.length });
  }
  if (url.includes("arbeitnow.com")) { net.an++; return Response.json({ data: ARBEITNOW }); }
  if (url.includes("api.openai.com")) {
    const body = JSON.parse(init.body);
    const user = body.messages[1].content;
    if (net.ai === "401") return new Response('{"error":{"message":"Incorrect API key provided"}}', { status: 401 });
    if (/Write a short cover letter/.test(body.messages[0].content)) {
      net.letters.push({ model: body.model, sys: body.messages[0].content, user });
      return Response.json({ choices: [{ message: { content: "Sehr geehrte Damen und Herren — Ihr ETCS-Dashboard … Mit freundlichen Grüßen, Diba Test" } }] });
    }
    const title = /Title: (.*)/.exec(user)[1];
    net.calls.push(title);
    assert.equal(body.model, "gpt-5.6-luna");
    const v = /Marketing/.test(title) ? { for: "none", reason: "marketing, not data science" }
      : /Frontend|React/.test(title) ? { for: "arman", kind: "werkstudent", why: "React Native work fits their React stack", gaps: [], german: "B2", hours: "20 h/week", start: "asap", deadline: "", lang: "de", skills: ["React", "TypeScript"] }
      : /^Data Scientist/.test(title) ? { for: "diba", kind: "full-time", why: "fits her ML work", gaps: [], german: "C1", hours: "40 h", start: "", deadline: "", lang: "de", skills: ["Python"] }
      : /Data Engineer/.test(title) ? { for: "diba", kind: "part-time", why: "SQL pipelines from her last job", gaps: ["Airflow - mention the Python automation"], german: "C1", hours: "20 h", start: "", deadline: "30.11.", lang: "de", skills: ["Airflow", "SQL", "Tableau"] }
      : { for: "diba", kind: "werkstudent", why: "Dashboards and SQL from her last job fit this analyst role", gaps: ["Tableau - mention Power BI and Metabase"], german: "B2", hours: "20 h/week", start: "asap", deadline: "15.11.", lang: /Working Student/.test(title) ? "en" : "de", skills: ["SQL", "Python", "Tableau"] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(v) } }] });
  }
  if (url.includes("api.telegram.org")) {
    const method = url.split("/").pop();
    // an upload (a CSV) comes as a form: its fields, and the file's name and text
    const body = init.body instanceof FormData
      ? Object.fromEntries(await Promise.all([...init.body.entries()].map(async ([k, v]) => [k, typeof v === "string" ? v : { name: v.name, text: await v.text() }])))
      : JSON.parse(init.body);
    // like the real one: a button's data is 64 bytes at most
    for (const b of (body.reply_markup?.inline_keyboard ?? []).flat())
      if (new TextEncoder().encode(b.callback_data).length > 64)
        return new Response('{"ok":false,"description":"Bad Request: BUTTON_DATA_INVALID"}', { status: 400 });
    net.tg.push({ method, body });
    return Response.json({ ok: true, result: { message_id: ++msgId } });
  }
  throw new Error("unexpected fetch " + url);
};
console.error = () => {};

const J = await import(SRC + "jobs.ts");
const { Store } = await import(SRC + "store.ts");
const { Telegram } = await import(SRC + "telegram.ts");
const worker = (await import(SRC + "index.ts")).default;

let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ✓", name); };
const env = (DB) => ({ DB, OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-5.6-terra", FINDS_MODEL: "gpt-5.6-luna",
  TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "-100", TELEGRAM_OWNER_ID: "1000001", WEBHOOK_SECRET: "s" });
const tg = new Telegram("T", "-100");
const { normalize } = await import(SRC + "config.ts");
const JOBS = normalize(CONFIG).jobs;
const fresh = async (config = CONFIG) => {
  const DB = makeDB(); const st = new Store(DB);
  await st.kvSet("config", JSON.stringify(config));
  for (const k of ["rooms", "jobs", "casual_jobs"]) await st.kvSet("intro:" + k, "1");     // said hello already
  await st.kvSet("jobs_people", JSON.stringify(PEOPLE));
  await st.kvSet("jobs_active", "diba,arman");
  await st.kvSet("profile", JSON.stringify({ about: { name: "Arman" }, style: {}, searches: [], filters: {} }));
  return [DB, st, env(DB)];
};
const sent = () => net.tg.filter((c) => c.method === "sendMessage");
const row = (DB, id) => ({ ...DB.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id) });

// ---------------------------------------------------------------- 1. rules
console.log("\n1. rules and dedupe (no AI)");
await ok("senior, lead, Ausbildung, freelance and off-topic titles are dropped", () => {
  for (const t of ["Senior Data Scientist (m/w/d)", "Lead Frontend Engineer", "Head of Data", "Teamleiter BI",
    "Ausbildung Fachinformatiker Daten- und Prozessanalyse", "Freelance React Developer", "Sachbearbeiter Buchhaltung (m/w/d)",
    "Data Analyst (m/w/d) in Vollzeit"])
    assert.ok(J.jobRejectReason(t, JOBS), t);
  for (const t of ["Werkstudent Data Analyst (m/w/d)", "Working Student Machine Learning", "Junior Data Engineer",
    "Werkstudent Frontend Entwicklung React (m/w/d)", "Business Intelligence Analyst", "Werkstudent Softwareentwicklung"])
    assert.equal(J.jobRejectReason(t, JOBS), null, t);
});
await ok("full-time listings are dropped unless the title says Werkstudent, intern, thesis or part-time", () => {
  assert.equal(J.jobRejectReason("Junior Data Engineer", JOBS, undefined, "full-time"), "full-time");
  assert.equal(J.jobRejectReason("Data Analyst", JOBS, undefined, "Full Time"), "full-time");
  for (const t of ["Werkstudent Data Analyst", "Working Student BI", "Praktikum Data Science", "Masterarbeit Machine Learning", "Data Analyst (Teilzeit)", "Data Engineer part-time"])
    assert.equal(J.jobRejectReason(t, JOBS, undefined, "full-time"), null, t);
});
await ok("the same job from two sources has the same key (legal form and (m/w/d) ignored)", () =>
  assert.equal(J.dedupeKey("Zalando SE", "Werkstudent Data Analyst (m/w/d)"), J.dedupeKey("Zalando", "Werkstudent Data Analyst")));

// ---------------------------------------------------------------- 2. flow
console.log("\n2. search → rules → AI → cards");
const [DB, st, E] = await fresh();
let r = await J.jobsStep(E, st, tg);
console.log("   tick 1:", r);
await ok("one tick: 2 Jobbörse searches + Arbeitnow; dupes across sources merged; rules before AI", () => {
  assert.equal(net.ba, 2); assert.equal(net.an, 1);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE company='Zalando'").get().n, 0);   // Arbeitnow copy of the Zalando job
  assert.equal(row(DB, "ba:10002").why, "senior or lead role");
  assert.equal(row(DB, "ba:10005").why, "not data or frontend work");
  assert.equal(row(DB, "ba:10008").why, "full-time");
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE id='ba:10003'").get().n, 0);       // Ausbildung never stored
});
await ok("matching: Jobbörse jobs get their description fetched; Arbeitnow's comes with the feed", () => {
  assert.ok(net.details >= 2);
  assert.ok(net.calls.includes("Werkstudent Data Analyst (m/w/d)"));
});
for (let i = 0; i < 3; i++) await J.jobsStep(E, st, tg);
await ok("the AI's 'none' isn't posted; everything else is, in topic 965", () => {
  assert.equal(row(DB, "ba:10007").why, "ai: marketing, not data science");
  assert.equal(row(DB, "ba:10009").why, "ai: full-time");
  const cards = sent().filter((c) => c.body.text.startsWith("💼"));
  assert.equal(cards.length, 5);
  assert.ok(!cards.some((c) => /Statista|Siemens/.test(c.body.text)));
  assert.ok(cards.every((c) => c.body.message_thread_id === 965));
});
const cardOf = (t) => sent().find((c) => c.body.text.startsWith("💼") && c.body.text.includes(t));
await ok("card: who it's for, Werkstudent, why, gaps, German level, hours, deadline - no rating", () => {
  const c = cardOf("Werkstudent Data Analyst").body.text;
  console.log("   card:\n     " + c.split("\n").join("\n     "));
  assert.match(c, /^💼 <b>[^<]+<\/b>\n🏢 [^\n]+\n📍 [^\n]*via [^\n]+\n\n👩‍💻 For Diba · 🎓 Werkstudent\n\n<i>/);
  assert.match(c, /\n\n⚠️ <b>Gaps<\/b>\n• Tableau - mention Power BI and Metabase\n\n/);
  assert.match(c, /\n\n🗣 German: B2\n⏱ Hours: 20 h\/week\n📅 Start: asap\n⏳ Apply by: 15\.11\.\n\n/);
  assert.match(c, /\n\n🔗 <a href="[^"]+">Open the job<\/a>$/);
  assert.ok(!/⭐|\b\d+\/10\b/.test(c));
});
await ok("a part-time job says so; Arman's React job is his", () => {
  assert.match(cardOf("Data Engineer").body.text, /⏱ Part-time/);
  assert.match(cardOf("Frontend").body.text, /🧑‍💻 For Arman/);
});
await ok("buttons on a new card: cover letter, applied, already applied, apply later, skip", () => {
  const kb = cardOf("Werkstudent Data Analyst").body.reply_markup.inline_keyboard.map((r) => r.map((b) => b.text));
  assert.deepEqual(kb, [["✍️ Cover letter"], ["✅ Applied", "🔁 Already applied"], ["🔖 Apply later", "⏭ Skip"]]);
});

// ---------------------------------------------------------------- 3. buttons
console.log("\n3. the application tracker");
const press = async (data, from = 555, chat = -100, message_id = 7) => {
  net.tg = [];
  await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query: { id: "q", data, from: { id: from }, message: { chat: { id: chat }, message_id } } }) }), E);
  return net.tg;
};
const analyst = "ba:10001";
let calls = await press(`jb:letter:diba:${analyst}`);
await ok("✍️ Cover letter: written on tap with the better model, from her CV, in the ad's language", () => {
  const l = net.letters.at(-1);
  assert.equal(l.model, "gpt-5.6-terra");
  assert.match(l.sys, /in German \(an Anschreiben/);
  assert.match(l.user, /Diba CV: two data/);
  assert.match(calls.find((c) => c.method === "sendMessage").body.text, /Cover letter for Diba[\s\S]*<pre>Sehr geehrte/);
  assert.ok(!calls.some((c) => c.method === "sendDocument"), "no CV saved yet, none sent");
});
await ok("…short, about this ad, plain words: 120-170 words, a detail from the ad first, stock phrases banned, no em dashes", () => {
  const l = net.letters.at(-1);
  assert.match(l.sys, /120-170 words/);
  assert.match(l.sys, /first sentence names something specific from this ad/);
  assert.match(l.sys, /passionate[\s\S]*hiermit bewerbe ich mich[\s\S]*Teamplayer/);
  assert.match(calls.find((c) => c.method === "sendMessage").body.text, /Herren - Ihr ETCS/);
});
await st.kvSet("jobs_cv:diba", "FILE-DIBA");
calls = await press(`jb:letter:diba:${analyst}`);
await ok("…and once her CV is saved, it comes right under the letter", () => {
  const d = calls.find((c) => c.method === "sendDocument");
  assert.equal(d.body.document, "FILE-DIBA");
  assert.equal(d.body.message_thread_id, 965);
  assert.ok(d.body.reply_to_message_id);
});
const cardMsg = row(DB, analyst).msg_id;
const editOf = (c) => c.find((x) => x.method === "editMessageText");
const kbOf = (m) => m.body.reply_markup.inline_keyboard.flat().map((b) => b.text);
calls = await press(`jb:applied:diba:${analyst}`, 555, -100, cardMsg);
await ok("✅ Applied: the card becomes 'Ad for … at … moved to the tracker' with an Undo button", () => {
  assert.equal(row(DB, analyst).status, "applied"); assert.equal(row(DB, analyst).person, "diba");
  const e = editOf(calls);
  assert.equal(e.body.message_id, cardMsg);
  assert.match(e.body.text, /^✅ Ad for <b>Werkstudent Data Analyst[^<]*<\/b> at <b>[^<]+<\/b> moved to the tracker \(applied by Diba\)\.\n<i>\/tracker - all of them<\/i>$/);
  assert.deepEqual(kbOf(e), ["↩️ Undo"]);
  assert.match(calls.find((c) => c.method === "answerCallbackQuery").body.text, /Moved to the tracker/);
});
calls = await press(editOf(calls).body.reply_markup.inline_keyboard[0][0].callback_data, 555, -100, cardMsg);
await ok("↩️ Undo: back to a new job, the full card and its buttons again", () => {
  const r = row(DB, analyst);
  assert.deepEqual([r.status, r.applied_at], ["posted", null]);
  const e = editOf(calls);
  assert.match(e.body.text, /^💼 <b>Werkstudent Data Analyst/);
  assert.deepEqual(kbOf(e), ["✍️ Cover letter", "✅ Applied", "🔁 Already applied", "🔖 Apply later", "⏭ Skip"]);
});
calls = await press(`jb:skip:-:ba:10004`, 555, -100, row(DB, "ba:10004").msg_id);
await ok("⏭ Skip: 'Ad for … at … skipped', with Undo", () => {
  assert.equal(row(DB, "ba:10004").status, "skipped");
  assert.match(editOf(calls).body.text, /^⏭ Ad for <b>.+<\/b> at <b>.+<\/b> skipped\.$/);
  assert.deepEqual(kbOf(editOf(calls)), ["↩️ Undo"]);
});
const later = DB.raw.prepare("SELECT id FROM jobs WHERE status='posted' AND id NOT IN ('ba:10001','ba:10006') ORDER BY id LIMIT 1").get().id;
calls = await press(`jb:later:diba:${later}`, 555, -100, row(DB, later).msg_id);
await ok("🔖 Apply later: 'moved to the waiting list', with Undo", () => {
  const r = row(DB, later);
  assert.deepEqual([r.status, r.person], ["approved", "diba"]); assert.ok(r.approved_at);
  assert.match(editOf(calls).body.text, /^🔖 Ad for <b>.+<\/b> moved to the waiting list \(for Diba\)\.\n<i>\/waitinglist - all of them<\/i>$/);
});
const say0 = async (text) => { net.tg = []; await worker.fetch(new Request("https://w/", { method: "POST",
  headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" },
  body: JSON.stringify({ message: { text, from: { id: 555 }, chat: { id: -100 }, message_thread_id: 965, is_topic_message: true } }) }), E); return net.tg; };
calls = await say0("/waiting-list");
await ok("/waiting-list (or /waitinglist): every waitlisted ad as its card, to apply from", () => {
  const m = calls.filter((c) => c.method === "sendMessage");
  assert.match(m[0].body.text, /^🔖 <b>Waiting list<\/b> · 1 ad to apply to$/);
  assert.match(m[1].body.text, /^💼 /); assert.match(m[1].body.text, /🔖 On the waiting list by Diba/);
  assert.deepEqual(kbOf(m[1]), ["✍️ Cover letter", "✅ Applied", "🔁 Already applied", "⏭ Skip"]);
  assert.ok(m.every((x) => x.body.message_thread_id === 965));
});
calls = await press(`jb:applied:diba:${later}`, 555, -100, row(DB, later).msg_id);
calls = await press(`jb:applied:diba:${analyst}`, 555, -100, cardMsg);
calls = await say0("/tracker");
await ok("/tracker: the counts, then each application with its status and the six status buttons (current one marked)", () => {
  const m = calls.filter((c) => c.method === "sendMessage");
  assert.match(m[0].body.text, /^📋 <b>Tracker<\/b> · 2 applications\n\n<pre>⏳ Waiting {11}2\n🗓 Interview set {5}0\n🎉 Offer received {4}0\n/);
  const t = m.find((x) => /Werkstudent Data Analyst/.test(x.body.text));
  assert.match(t.body.text, /^📋 <b>Werkstudent Data Analyst[\s\S]*\n\n👩‍💻 Diba · applied \d\d\.\d\d\n\nStatus: <b>⏳ Waiting for an answer<\/b>\n\n🔗 <a /);
  assert.deepEqual(t.body.reply_markup.inline_keyboard.map((r) => r.map((b) => b.text)),
    [["• ⏳ Waiting •", "❌ Rejected"], ["🗓 Interview set", "🎉 Offer received"], ["🙅 Offer declined", "🤝 Offer accepted"]]);
});
const tcard = calls.find((x) => /Werkstudent Data Analyst/.test(x.body.text ?? ""));
const tbtn = (label) => tcard.body.reply_markup.inline_keyboard.flat().find((b) => b.text.includes(label)).callback_data;
calls = await press(tbtn("Interview set"), 555, -100, 4321);
const pressed = calls;
await ok("/tracker has a 'Download as Excel' button", async () => {
  const t = await say0("/tracker");
  assert.deepEqual(kbOf(t.find((c) => c.method === "sendMessage")), ["📥 Download as Excel"]);
});
const csvCalls = await say0("/tracker csv");
await ok("/tracker csv (or excel): an .xlsx of every application, coloured headers, sent into the topic", () => {
  const d = csvCalls.find((c) => c.method === "sendDocument");
  assert.ok(d, csvCalls.map((c) => c.method).join(" "));
  assert.match(d.body.document.name, /^tracker-\d{4}-\d\d-\d\d\.xlsx$/);
  assert.equal(d.body.message_thread_id, "965"); assert.match(d.body.caption, /Tracker · 2 applications/);
  assert.ok(d.body.document.text.startsWith("PK"), "a zip");
  assert.match(d.body.document.text, /<fgColor rgb="FFBFDBFE"\/>/);                 // the Title column's colour
  assert.match(d.body.document.text, /<pane ySplit="1"[^>]*state="frozen"\/>/);
});
await ok("…with the columns asked for, one row each (the same rows as the plain CSV)", () => {
  const rows = DB.raw.prepare("SELECT * FROM jobs WHERE status IN ('applied','already','interview','rejected','offer','declined','accepted')").all();
  const lines = J.trackerCsv(rows, JOBS).replace(/^\ufeff/, "").trim().split("\r\n");
  assert.equal(lines[0], "Title,Company,City,Remote / hybrid / on-site,Status,General or career-centered,German required,German level");
  assert.equal(lines.length, 3);
  const a = lines.find((l) => l.startsWith("Werkstudent Data Analyst"));
  assert.match(a, /,Berlin,hybrid,Interview set,career-centered,yes,B2$/);
  const other = lines.find((l) => l !== a && l !== lines[0]);
  assert.match(other, /,(general|career-centered),(yes|no),/);
});
await ok("career-centered: an on-topic Werkstudent, internship, thesis or junior role; general: part-time and the rest", () => {
  const r = (kind, title = "Data Analyst") => J.trackerCsv([{ id: "x:1", title, company: "C", place: "Berlin", remote: 0, text: "", status: "applied", person: "diba", facts: JSON.stringify({ kind }) }], JOBS).split("\r\n")[1];
  assert.match(r("werkstudent"), /,career-centered,/); assert.match(r("internship"), /,career-centered,/);
  assert.match(r("part-time"), /,general,/); assert.match(r("other"), /,general,/);
});
await ok("the CSV's guesses: work mode, German and its level", () => {
  assert.equal(J.workMode({ remote: 1, place: "Remote", text: "", title: "" }), "remote");
  assert.equal(J.workMode({ remote: 0, place: "Berlin · home office possible", text: "", title: "" }), "hybrid");
  assert.equal(J.workMode({ remote: 0, place: "Berlin", text: "2 Tage remote pro Woche", title: "" }), "hybrid");
  assert.equal(J.workMode({ remote: 0, place: "Cottbus", text: "Vor Ort im Büro", title: "" }), "on-site");
  assert.deepEqual(J.germanOf("B2"), ["yes", "B2"]); assert.deepEqual(J.germanOf("fließend (C1)"), ["yes", "C1"]);
  assert.deepEqual(J.germanOf("fluent"), ["yes", "fluent (C1+)"]); assert.deepEqual(J.germanOf("not stated"), ["not stated", ""]);
  assert.deepEqual(J.germanOf(""), ["not stated", ""]); assert.deepEqual(J.germanOf("nice to have"), ["no", ""]);
  // nothing from the AI: the ad's own words
  assert.deepEqual(J.germanOf("", "Sehr gute Deutschkenntnisse (C1) erforderlich."), ["yes", "C1"]);
  assert.deepEqual(J.germanOf("not stated", "Fließend Deutsch in Wort und Schrift."), ["yes", "fluent (C1+)"]);
  assert.deepEqual(J.germanOf("", "Deutschkenntnisse sind von Vorteil."), ["no", ""]);
  assert.deepEqual(J.germanOf("", "We work in English."), ["not stated", ""]);
});
await ok("a title with a comma or quotes stays one cell", () => {
  const csv = J.trackerCsv([{ id: "x:1", title: 'Data Analyst, "Junior"', company: "A; B", place: "Berlin", remote: 0, text: "", status: "applied", person: "diba", facts: null }], JOBS);
  assert.match(csv, /\r\n"Data Analyst, ""Junior""","A; B",Berlin,on-site,/);
});
calls = pressed;
await ok("a status button: saved, and that message shows the new status in place", () => {
  assert.equal(row(DB, analyst).status, "interview");
  const e = editOf(calls);
  assert.equal(e.body.message_id, 4321);
  assert.match(e.body.text, /Status: <b>🗓 Interview set<\/b>/);
  assert.ok(kbOf(e).includes("• 🗓 Interview set •"));
});
for (const [label, st] of [["Offer received", "offer"], ["Offer accepted", "accepted"], ["Offer declined", "declined"], ["Rejected", "rejected"], ["Waiting", "applied"]]) {
  await press(tbtn(label), 555, -100, 4321);
  await ok(`… ${label} → ${st}`, () => assert.equal(row(DB, analyst).status, st));
}
await press(tbtn("Interview set"), 555, -100, 4321);
await press(`jb:already:diba:ba:10006`);
DB.raw.prepare("UPDATE jobs SET applied_at = ? WHERE id='ba:10006'").run(Math.floor(Date.now() / 1000) - 11 * 86400);
net.tg = [];
await J.jobsStep(E, st, tg);
await ok("no answer after 10 days: one reminder, as its tracker card with the status buttons", () => {
  const m = sent().find((c) => /No answer after 10 days/.test(c.body.text));
  assert.ok(m); assert.ok(!m.body.reply_to_message_id);
  assert.ok(m.body.reply_markup.inline_keyboard.flat().map((x) => x.text).includes("🗓 Interview set"));
  assert.match(m.body.text, /🏢 Vattenfall GmbH/);
  assert.equal(row(DB, "ba:10006").reminded, 1);
});
net.tg = []; await J.jobsStep(E, st, tg);
await ok("…and only once", () => assert.ok(!sent().some((c) => /No answer after/.test(c.body.text))));

// ---------------------------------------------------------------- 4. commands
console.log("\n4. /jobs, /skills, /jobreport, permissions");
const say = async (text, from = 555, chat = -100) => {
  net.tg = [];
  await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" },
    body: JSON.stringify({ message: { text, from: { id: from }, chat: { id: chat }, message_thread_id: 965, is_topic_message: true } }) }), E);
  return net.tg;
};
calls = await say("/jobs");
await ok("/jobs: a table per person - new, waiting list, tracker and each tracker status - and the two list buttons", () => {
  const t = calls[0].body.text;
  console.log("   /jobs ->\n     " + t.split("\n").join("\n     "));
  assert.match(t, /👩‍💻 <b>Diba<\/b>\n<pre>🆕 New {17}\d+\n🔖 Waiting list {8}0\n📋 Tracker {13}3\n {3}⏳ Waiting {10}2\n {3}🗓 Interview set {4}1\n/);
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard.flat().map((b) => b.text), ["🔖 Waiting list (0)", "📋 Tracker (3)"]);
  assert.equal(calls[0].body.message_thread_id, 965);
});
const sayMsg = async (message) => {
  net.tg = [];
  await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" },
    body: JSON.stringify({ message: { from: { id: 555 }, chat: { id: -100 }, message_thread_id: 965, is_topic_message: true, ...message } }) }), E);
  return net.tg;
};
await st.kvSet("jobs_cv:diba", "");
calls = await sayMsg({ text: "/cv" });
await ok("/cv with nothing saved says how to save one", () => assert.match(calls[0].body.text, /answer it with \/cv diba/));
calls = await sayMsg({ text: "/cv diba", reply_to_message: { document: { file_id: "FILE-2" } } });
await ok("answering a PDF with /cv diba saves it as her CV", async () => {
  assert.equal(await st.kvGet("jobs_cv:diba"), "FILE-2");
  assert.match(calls[0].body.text, /Saved as Diba's CV/);
});
calls = await sayMsg({ caption: "/cv diba", document: { file_id: "FILE-3" } });
await ok("…so does sending the PDF with /cv diba as the caption", async () => assert.equal(await st.kvGet("jobs_cv:diba"), "FILE-3"));
calls = await sayMsg({ caption: "/cv", document: { file_id: "FILE-4" } });
await ok("…but not without a name", async () => {
  assert.match(calls[0].body.text, /Whose CV is it/);
  assert.equal(await st.kvGet("jobs_cv:diba"), "FILE-3");
});
calls = await sayMsg({ text: "/cv" });
await ok("/cv sends the saved CVs into the topic", () => {
  const d = calls.filter((c) => c.method === "sendDocument");
  assert.deepEqual(d.map((c) => c.body.document), ["FILE-3"]);
  assert.equal(d[0].body.message_thread_id, 965);
});
calls = await say("/skills diba + Tableau");
await ok("/skills diba + Tableau: added to what she's matched against", async () => {
  assert.match(calls[0].body.text, /Tableau/);
  assert.ok(JSON.parse(await st.kvGet("jobs_skills:diba")).includes("Tableau"));
});
await st.kvSet("jobs_skills:diba", JSON.stringify(["Python", "SQL", "Power BI"]));
calls = await say("/jobreport");
await ok("/jobreport: matches by city, what gets answers, due follow-ups, the one skill to learn", () => {
  const t = calls[0].body.text;
  console.log("   report ->\n     " + t.split("\n").join("\n     "));
  assert.match(t, /New matches this week: \d+ \(Berlin \d+, Cottbus \d+, remote \d+\)/);
  assert.match(t, /werkstudent, German ad, via Jobbörse: 1 interviews from 1/);
  assert.match(t, /Follow up: Vattenfall GmbH/);
  assert.match(t, /Worth learning: <b>Tableau<\/b>/);
});
calls = await say("/jobs", 555, 555);
await ok("a stranger in a private chat is refused", () => assert.match(calls[0].body.text, /only answers to them/));
net.ai = "401"; DB.raw.prepare("UPDATE jobs SET status='new', attempts=0 WHERE id='an:acme-working-student-ml'").run();
net.tg = []; await J.jobsStep(E, st, tg);
await ok("a dead OpenAI key: one alert, the job waits for another try", () => {
  assert.ok(sent().some((c) => /rejected the API key/.test(c.body.text)));
  assert.equal(row(DB, "an:acme-working-student-ml").status, "new");
});
net.ai = "ok";

await ok("kv jobs_repost=1: untouched cards are deleted and posted again, once; tracked ones stay", async () => {
  net.tg = []; await J.jobsStep(E, st, tg);     // the job the dead key held back gets posted
  const open = DB.raw.prepare("SELECT id, msg_id FROM jobs WHERE status='posted'").all();
  assert.ok(open.length > 0);
  await st.kvSet("jobs_repost", "1");
  net.tg = []; await J.jobsStep(E, st, tg);
  const del = net.tg.filter((c) => c.method === "deleteMessage").map((c) => c.body.message_id).sort();
  assert.deepEqual(del, open.map((r) => r.msg_id).filter(Boolean).sort());
  assert.equal(sent().filter((c) => /Open the job/.test(c.body.text)).length, Math.min(open.length, 4));
  assert.equal(row(DB, analyst).status, "interview");
  assert.equal(await st.kvGet("jobs_repost"), "0");
  net.tg = []; await J.jobsStep(E, st, tg);
  assert.ok(!net.tg.some((c) => c.method === "deleteMessage"));
});

await ok("kv jobs_repost=all: every job message the bot knows of is deleted; new ones go out again, tracked ones stay tracked", async () => {
  DB.raw.prepare("UPDATE jobs SET msg_id=777 WHERE id=?").run(analyst);            // a tracked one with a message
  const withMsg = DB.raw.prepare("SELECT id, status, msg_id FROM jobs WHERE msg_id IS NOT NULL").all();
  const open = withMsg.filter((r) => r.status === "posted").length;
  await st.kvSet("jobs_repost", "all");
  net.tg = []; await J.jobsStep(E, st, tg);
  assert.deepEqual(net.tg.filter((c) => c.method === "deleteMessage").map((c) => c.body.message_id).sort(), withMsg.map((r) => r.msg_id).sort());
  assert.equal(row(DB, analyst).msg_id, null); assert.equal(row(DB, analyst).status, "interview");
  assert.equal(sent().filter((c) => /^💼 /.test(c.body.text)).length, Math.min(open, 4));
  assert.equal(await st.kvGet("jobs_repost"), "0");
});
await ok("kv jobs_repost=recheck: full-time cards come down for good; the rest are matched again and re-posted", async () => {
  const open = DB.raw.prepare("SELECT id FROM jobs WHERE status='posted'").all().map((r) => r.id);
  const keep = open.find((id) => id !== "ba:10001");
  DB.raw.prepare("UPDATE jobs SET kind='full-time', title='AI Engineer (m/w/d)' WHERE id=?").run(keep);   // posted before the rule
  await st.kvSet("jobs_repost", "recheck");
  net.calls = []; net.tg = []; await J.jobsStep(E, st, tg);
  assert.equal(net.tg.filter((c) => c.method === "deleteMessage").length, open.length);
  assert.equal(row(DB, keep).status, "skipped"); assert.equal(row(DB, keep).why, "full-time"); assert.equal(row(DB, keep).msg_id, null);
  for (let i = 0; i < 3; i++) await J.jobsStep(E, st, tg);
  assert.ok(net.calls.length > 0, "the others went back to the AI");
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE status='posted'").get().n, open.length - 1);
});

await ok('the "/" menu: shared commands for the group, all of them for the owner; sent once', async () => {
  const tick = async () => { const w = []; await worker.scheduled({ cron: J.JOBS_CRON, scheduledTime: Date.UTC(2026, 9, 29, 10, 3) }, E, { waitUntil: (p) => w.push(p) }); await Promise.all(w); };
  net.tg = []; await tick();
  const c = net.tg.filter((x) => x.method === "setMyCommands");
  assert.equal(c.length, 3);
  const group = c.find((x) => x.body.scope.type === "chat" && x.body.scope.chat_id === "-100");
  assert.deepEqual(group.body.commands.map((x) => x.command), ["jobs", "waitinglist", "tracker", "cv", "jobreport", "skills", "finds", "casual"]);
  const mine = c.find((x) => x.body.scope.type === "chat_member");
  assert.equal(mine.body.scope.user_id, 1000001);
  assert.ok(mine.body.commands.some((x) => x.command === "review") && mine.body.commands.some((x) => x.command === "jobs"));
  net.tg = []; await tick();
  assert.ok(!net.tg.some((x) => x.method === "setMyCommands"));
});

console.log("\n5. only Diba searching (arman: active: false)");
{
  const [DB2, st2, E2] = await fresh({ ...CONFIG, jobs: { ...CONFIG.jobs,
    people: CONFIG.jobs.people.map((p) => (p.id === "arman" ? { ...p, active: false } : p)) } });
  DB2.raw.prepare("DELETE FROM kv WHERE k='jobs_active'").run();
  net.ba = 0; net.calls = []; net.tg = [];
  const urls = [];
  const f0 = globalThis.fetch;
  globalThis.fetch = (u, i) => { if (String(u).includes("arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs")) urls.push(new URL(String(u)).searchParams.get("was")); return f0(u, i); };
  for (let i = 0; i < 8; i++) await J.jobsStep(E2, st2, tg);
  globalThis.fetch = f0;
  await ok("no Arman searches; frontend titles dropped by rules before any AI call", () => {
    assert.ok(urls.length > 0);
    assert.ok(urls.every((q) => !/Frontend|React|Software|Web/.test(q)), urls.join(", "));
    assert.equal(row(DB2, "ba:10004").why, "not data work");
    assert.ok(!net.calls.some((t) => /Frontend/.test(t)));
  });
  await ok("the AI is only told about Diba; nothing is posted for Arman", () => {
    assert.ok(!sent().some((c) => /For Arman|Diba & Arman/.test(c.body.text)));
  });
  net.tg = [];
  await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" },
    body: JSON.stringify({ message: { text: "/jobs", from: { id: 555 }, chat: { id: -100 } } }) }), E2);
  await ok("/jobs only lists Diba", () => {
    const t = net.tg[0].body.text;
    assert.match(t, /Diba/); assert.ok(!/Arman<\/b>/.test(t));
  });
}

console.log("\n6. a job with a very long id");
{
  const [DB3, st3, E3] = await fresh();
  const slug = "working-student-ai-solutions-architect-generative-ai-data-platforms-berlin-283450";
  ARBEITNOW.push({ slug, company_name: "AgentixLake GmbH", title: "Working Student Data Platforms", description: "<p>Python, SQL</p>", remote: false, url: "https://arbeitnow.example/long", location: "Berlin", job_types: ["Student"] });
  net.tg = [];
  for (let i = 0; i < 6; i++) await J.jobsStep(E3, st3, tg);
  const id = "an:" + slug;
  const m = sent().find((c) => /AgentixLake/.test(c.body.text));
  await ok("the card goes out: every button fits Telegram's 64 bytes", () => {
    assert.ok(m, DB3.raw.prepare("SELECT status, why FROM jobs WHERE id=?").get(id)?.why ?? "not found");
    assert.equal(row(DB3, id).status, "posted");
    for (const b of m.body.reply_markup.inline_keyboard.flat()) assert.ok(new TextEncoder().encode(b.callback_data).length <= 64, b.callback_data);
  });
  const btn = (label) => m.body.reply_markup.inline_keyboard.flat().find((b) => b.text.startsWith(label)).callback_data;
  const tap = async (data) => { net.tg = []; await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query: { id: "q", data, from: { id: 555 }, message: { chat: { id: -100 }, message_id: 7 } } }) }), E3); return net.tg; };
  let c = await tap(btn("✍️ Cover letter"));
  await ok("its cover letter button finds the job", () => assert.match(c.find((x) => x.method === "sendMessage").body.text, /Cover letter for Diba<\/b> - AgentixLake/));
  c = await tap(btn("✅ Applied"));
  await ok("Applied finds that job, and its Undo and tracker buttons fit too", () => {
    assert.equal(row(DB3, id).status, "applied");
    const e = c.find((x) => x.method === "editMessageText");
    assert.ok(e.body.reply_markup.inline_keyboard.flat().every((b) => new TextEncoder().encode(b.callback_data).length <= 64));
    for (const b of J.jobKeyboard(row(DB3, id), JOBS).flat()) assert.ok(new TextEncoder().encode(b.callback_data).length <= 64, b.callback_data);
  });
  c = await tap("jb:skip:-:~no-such-job-ends-like-this");
  await ok("a shortened id that matches nothing is just unknown", () => assert.equal(c[0].body.text, "Unknown job"));
  // a card Telegram refuses: the reason is kept
  const f0 = globalThis.fetch;
  globalThis.fetch = (u, i) => (String(u).endsWith("/sendMessage") ? new Response('{"ok":false,"description":"Bad Request: something else"}', { status: 400 }) : f0(u, i));
  DB3.raw.prepare("UPDATE jobs SET status='ready', attempts=2 WHERE id='ba:10001'").run();
  await J.jobsStep(E3, st3, tg);
  globalThis.fetch = f0;
  await ok("when a card can't be posted, why is kept", () => assert.match(row(DB3, "ba:10001").why, /^could not post: .*something else/));
}

console.log("\n7. jobs handed in from outside (LinkedIn, via the Mac)");
{
  const [DB4, st4, E0] = await fresh();
  const E4 = { ...E0, INGEST_SECRET: "in-secret" };
  const hand = (body, secret = "in-secret") => worker.fetch(new Request("https://w/ingest/jobs", { method: "POST",
    headers: { "X-Ingest-Secret": secret, "Content-Type": "application/json" }, body: JSON.stringify(body) }), E4);
  const li = (id, title, company, kind = "", text = "SQL, Python, Dashboards. 20 Stunden pro Woche.") =>
    ({ id: "li:" + id, source: "LinkedIn", title, company, place: "Berlin, Berlin, Germany", url: `https://www.linkedin.com/jobs/view/${id}`, remote: false, kind, text });
  await ok("without the secret: refused", async () => {
    assert.equal((await hand({ op: "known", jobs: [] }, "wrong")).status, 403);
    const [D, s2, E5] = await fresh();
    assert.equal((await worker.fetch(new Request("https://w/ingest/jobs", { method: "POST", body: "{}" }), E5)).status, 403);
  });
  // one LinkedIn job is a job the Jobbörse already brought (same company and title)
  await J.jobsStep(E4, st4, tg);
  const known = await (await hand({ op: "known", jobs: [li("1", "Werkstudent Data Analyst (m/w/d)", "Zalando SE"), li("2", "Working Student Analytics", "Acme Berlin")] })).json();
  await ok("'which of these are new?': a job already found elsewhere isn't", () => assert.deepEqual(known.unknown, ["li:2"]));
  const added = await (await hand({ op: "add", jobs: [li("2", "Working Student Analytics", "Acme Berlin"),
    li("3", "Junior Data Engineer", "Big Corp", "Full-time"), li("4", "Senior Data Scientist", "X")] })).json();
  await ok("'add these': the same rules as every other job - full-time and senior stay out", () => {
    assert.deepEqual(added, { fresh: 3, keep: 1 });
    assert.equal(row(DB4, "li:2").status, "new");
    assert.equal(row(DB4, "li:3").why, "full-time"); assert.equal(row(DB4, "li:4").why, "senior or lead role");
    assert.match(row(DB4, "li:2").text, /SQL, Python/);
  });
  net.tg = [];
  for (let i = 0; i < 4; i++) await J.jobsStep(E4, st4, tg);
  await ok("…then matched and posted like the rest, via LinkedIn", () => {
    const c = sent().find((x) => /Working Student Analytics/.test(x.body.text));
    assert.ok(c); assert.match(c.body.text, /🏢 Acme Berlin\n📍 Berlin, Berlin, Germany · via LinkedIn/);
    assert.match(c.body.text, /href="https:\/\/www\.linkedin\.com\/jobs\/view\/2"/);
  });
  await ok("nonsense is refused, not stored", async () => {
    assert.equal((await hand({ op: "add", jobs: [{ id: "x", title: 5 }] })).status, 400);
    assert.equal((await hand({ op: "nope" })).status, 400);
  });
}

console.log(`\nall ${pass} jobs checks passed`);
