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
const net = { ai: "ok", calls: [], tg: [], ba: 0, an: 0, details: 0, letters: [], edits: [], letter: null };
const LETTER = { lang: "de", subject: "Bewerbung als Werkstudentin Data Analyst (Ref. 10001)", salutation: "Sehr geehrte Damen und Herren,",
  body: "Ihr ETCS-Dashboard für den Bahnbetrieb hat mich sofort angesprochen.\n\nBei meinem letzten Job habe ich Dashboards mit SQL gebaut.\n\nIch kann 20 Stunden pro Woche arbeiten, ab sofort.",
  closing: "Mit freundlichen Grüßen", why: "Weil Ihr Team Daten wirklich nutzt." };
let msgId = 100;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("arbeitsagentur.de")) {
    if (url.includes("/jobdetails/")) {
      net.details++;
      return Response.json({ stellenangebotsBeschreibung: "Aufgaben: SQL, Python, Dashboards mit Tableau. Deutsch B2. 20 Std./Woche." + "\nDu arbeitest mit unserem Analytics-Team an Berichten für den Vertrieb und den Einkauf und bereitest Kennzahlen für die Geschäftsführung auf.".repeat(7), externeURL: "https://apply.example" });
    }
    net.ba++;
    return Response.json({ ergebnisliste: BA_RESULTS, maxErgebnisse: BA_RESULTS.length });
  }
  if (url.includes("arbeitnow.com")) { net.an++; return Response.json({ data: ARBEITNOW }); }
  if (url.includes("api.openai.com")) {
    const body = JSON.parse(init.body);
    const user = body.messages[1].content;
    if (net.ai === "401") return new Response('{"error":{"message":"Incorrect API key provided"}}', { status: 401 });
    if (/You write job applications/.test(body.messages[0].content)) {
      net.letters.push({ model: body.model, sys: body.messages[0].content, user, json: body.response_format?.type });
      return Response.json({ choices: [{ message: { content: JSON.stringify(net.letter ?? LETTER) } }] });
    }
    if (/You edit a job application letter/.test(body.messages[0].content)) {
      const todo = /=== DO ===\n([\s\S]*)$/.exec(user)[1];
      net.edits.push({ model: body.model, todo });
      const en = /in English/.test(todo);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ ...LETTER, lang: en ? "en" : "de", salutation: en ? "Dear Hiring Team," : LETTER.salutation,
        closing: en ? "Kind regards" : LETTER.closing, body: `${LETTER.body}\n\n(${todo.slice(0, 40)})` }) } }] });
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
  assert.deepEqual(kb, [["✍️ Cover letter"], ["✅ Applied", "🔁 Already applied"], ["🔖 Apply later", "⏭ Skip", "🚫 Closed"]]);
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
const letterMsg = (c) => c.find((x) => x.method === "sendMessage" && /Cover letter for/.test(x.body.text ?? ""));
const pdfOf = (c) => c.find((x) => x.method === "sendDocument" && typeof x.body.document === "object");
await ok("✍️ Cover letter: one call to the better model - her profile and CV first (cached), the ad and her style after", () => {
  const l = net.letters.at(-1);
  assert.equal(net.letters.length, 1); assert.equal(l.model, "gpt-5.6-terra"); assert.equal(l.json, "json_object");
  assert.match(l.sys, /^You write job applications for Diba/); assert.match(l.sys, /=== CV ===\nDiba CV: two data/);
  assert.match(l.sys, /Only strengths\. Never mention a skill, tool or experience they don't have/);
  assert.match(l.sys, /contact person if the ad names one/); assert.match(l.sys, /why: 2-3 sentences/);
  assert.match(l.user, /^=== JOB ===\nTitle: Werkstudent Data Analyst[\s\S]*Reference: 10001[\s\S]*=== STYLE ===\nAbout 160 words in the body\. Tone: friendly and professional\.$/);
  assert.ok(!/Tableau - mention/.test(l.sys + l.user), "the gaps are never handed to the writer");
});
await ok("…the message: subject, the whole letter to copy, a 'Why us?' for the form, and the buttons", () => {
  const m = letterMsg(calls);
  assert.match(m.body.text, /^✍️ <b>Cover letter for Diba<\/b> · [^\n]+\n\n<b>Subject:<\/b> Bewerbung als Werkstudentin Data Analyst \(Ref\. 10001\)\n\n<pre>Sehr geehrte Damen und Herren,\n\nIhr ETCS-Dashboard[\s\S]*Mit freundlichen Grüßen\nDiba [^<]+<\/pre>\n\n💬 <b>Why us\?<\/b> \(for the application form\)\n<pre>Weil Ihr Team/);
  assert.deepEqual(m.body.reply_markup.inline_keyboard.map((r) => r.map((b) => b.text)), [["✅ Fine, I sent it"], ["✏️ Change the letter", "🙅 Never mind"]]);
  assert.equal(m.body.reply_to_message_id, 7);
});
await ok("…and a PDF of it, ready to upload (no CV saved yet, so none sent)", () => {
  const d = pdfOf(calls);
  assert.match(d.body.document.name, /^Anschreiben_.+\.pdf$/); assert.ok(d.body.document.text.startsWith("%PDF-1.4"));
  assert.match(d.body.caption, /Anschreiben as PDF/);
  assert.ok(!calls.some((c) => c.method === "sendDocument" && c.body.document === "FILE-DIBA"));
});
// the writer claims a tool from the ad that isn't in her CV: the free check catches it, the cheap model fixes it
net.letter = { ...LETTER, body: LETTER.body + " Tableau nutze ich täglich, und die Berichtszeit sank um 73 %." };
calls = await press(`jb:letter:diba:${analyst}`);
await ok("a claim the CV doesn't back (a tool from the ad, a number from nowhere): found in code, fixed by the cheap model", () => {
  const e = net.edits.at(-1);
  assert.equal(e.model, "gpt-5.6-luna");
  assert.match(e.todo, /claims "Tableau", which isn't in the CV/); assert.match(e.todo, /the number "73 ?%" isn't in the CV or the ad/);
});
net.letter = null;
const before = net.edits.length;
calls = await press(`jb:letter:diba:${analyst}`);
await ok("…a clean letter costs nothing more: no second call", () => assert.equal(net.edits.length, before));
await st.kvSet("jobs_cv:diba", "FILE-DIBA");
calls = await press(`jb:letter:diba:${analyst}`);
await ok("…and once her CV is saved, it comes right under the letter", () => {
  const d = calls.find((c) => c.method === "sendDocument" && c.body.document === "FILE-DIBA");
  assert.ok(d); assert.equal(d.body.message_thread_id, 965); assert.ok(d.body.reply_to_message_id);
});
const lm = letterMsg(calls), lmId = 900;
const mainBtn = (label) => lm.body.reply_markup.inline_keyboard.flat().find((b) => b.text === label).callback_data;
calls = await press(mainBtn("✏️ Change the letter"), 555, -100, lmId);
const editKb = calls.find((c) => c.method === "editMessageText").body.reply_markup.inline_keyboard;
await ok("✏️ Change the letter: the same message shows how - shorter, longer, tone, language, new version, in my own words, back; no AI call", () => {
  assert.deepEqual(editKb.map((r) => r.map((b) => b.text)), [["✂️ Shorter", "📏 Longer"], ["🎩 More formal", "😊 More casual"], ["🇬🇧 English", "🔄 New version"], ["✏️ Change something"], ["⬅️ Back"]]);
  assert.equal(calls.find((c) => c.method === "editMessageText").body.message_id, lmId);
  assert.ok(!calls.some((c) => c.method === "sendDocument"));
});
calls = await press(editKb.flat().find((b) => b.text === "⬅️ Back").callback_data, 555, -100, lmId);
await ok("⬅️ Back: the three choices again", () =>
  assert.deepEqual(calls.find((c) => c.method === "editMessageText").body.reply_markup.inline_keyboard.flat().map((b) => b.text), ["✅ Fine, I sent it", "✏️ Change the letter", "🙅 Never mind"]));
const lbtn = (label) => editKb.flat().find((b) => b.text === label).callback_data;
calls = await press(lbtn("✂️ Shorter"), 555, -100, lmId);
await ok("✂️ Shorter: the cheap model edits it, the message changes in place, a new PDF replaces the old one", async () => {
  assert.equal(net.edits.at(-1).model, "gpt-5.6-luna"); assert.match(net.edits.at(-1).todo, /noticeably shorter/);
  const e = calls.find((c) => c.method === "editMessageText"); assert.equal(e.body.message_id, lmId); assert.match(e.body.text, /noticeably shorter/);
  assert.ok(calls.some((c) => c.method === "deleteMessage")); assert.ok(pdfOf(calls));
  assert.deepEqual(e.body.reply_markup.inline_keyboard.flat().map((b) => b.text), ["✅ Fine, I sent it", "✏️ Change the letter", "🙅 Never mind"], "after a change: the three choices");
});
await ok("…and it's learned: her next letters aim shorter", async () => assert.deepEqual(JSON.parse(await st.kvGet("letter_style:diba")), { words: 140, tone: 0 }));
await press(lbtn("😊 More casual"), 555, -100, lmId); await press(lbtn("😊 More casual"), 555, -100, lmId); await press(lbtn("🎩 More formal"), 555, -100, lmId);
await ok("more casual twice, more formal once: a little casual", async () => assert.equal(JSON.parse(await st.kvGet("letter_style:diba")).tone, -1));
calls = await press(lbtn("🇬🇧 English"), 555, -100, lmId);
await ok("🇬🇧 English: rewritten in English; its change menu now offers Deutsch; the language isn't learned (it follows the ad)", async () => {
  const e = calls.find((c) => c.method === "editMessageText");
  assert.match(e.body.text, /<pre>Dear Hiring Team,/); assert.match(pdfOf(calls).body.caption, /Cover letter as PDF/);
  const again = (await press(mainBtn("✏️ Change the letter"), 555, -100, lmId)).find((c) => c.method === "editMessageText");
  assert.deepEqual(again.body.reply_markup.inline_keyboard[2].map((b) => b.text), ["🇩🇪 Deutsch", "🔄 New version"]);
  assert.deepEqual(JSON.parse(await st.kvGet("letter_style:diba")), { words: 140, tone: -1 });
});
calls = await press(lbtn("📏 Longer"), 555, -100, lmId);
await ok("📏 Longer: the cheap model makes it longer, with substance, and her next letters aim a bit longer again", async () => {
  assert.match(net.edits.at(-1).todo, /noticeably longer[\s\S]*never filler/);
  assert.ok(calls.find((c) => c.method === "editMessageText"));
  assert.equal(JSON.parse(await st.kvGet("letter_style:diba")).words, 160);
});
await press(lbtn("✂️ Shorter"), 555, -100, lmId);
calls = await press(`jb:letter:diba:${analyst}`);
await ok("the next letter is written to her style: shorter and a little casual", () =>
  assert.match(net.letters.at(-1).user, /About 140 words in the body\. Tone: warm and a little casual\.$/));
// 🙅 Never mind on a fresh letter: letter and PDF come down, the job stays as it was
calls = await press(`jb:letter:diba:${analyst}`);
{
  const kept = JSON.parse(await st.kvGet(`letter:${analyst}:diba`));
  const nm = letterMsg(calls).body.reply_markup.inline_keyboard.flat().find((b) => b.text === "🙅 Never mind").callback_data;
  const statusBefore = row(DB, analyst).status;
  calls = await press(nm, 555, -100, kept.msg);
  await ok("🙅 Never mind: the letter and its PDF are deleted, the job stays as it was", async () => {
    const del = calls.filter((c) => c.method === "deleteMessage").map((c) => c.body.message_id);
    assert.ok(del.includes(kept.msg) && del.includes(kept.pdf), JSON.stringify(del));
    assert.equal(row(DB, analyst).status, statusBefore);
    assert.equal(await st.kvGet(`letter:${analyst}:diba`), "null");
  });
}
calls = await press(`jb:wshort:diba:ba:10004`);
await ok("a letter button on a job without a letter yet says what to do", () =>
  assert.match(calls.find((c) => c.method === "answerCallbackQuery").body.text, /Tap ✍️ Cover letter on the job first/));
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
  assert.deepEqual(kbOf(e), ["✍️ Cover letter", "✅ Applied", "🔁 Already applied", "🔖 Apply later", "⏭ Skip", "🚫 Closed"]);
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
  assert.deepEqual(kbOf(m[1]), ["✍️ Cover letter", "✅ Applied", "🔁 Already applied", "⏭ Skip", "🚫 Closed"]);
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
  assert.deepEqual(J.germanOf("B2"), ["yes", "B2"]); assert.deepEqual(J.germanOf("fließend (C1)"), ["yes", "B2"]);   // the AI saying C1 isn't the ad saying it
  assert.deepEqual(J.germanOf("fluent"), ["yes", "B2"]); assert.deepEqual(J.germanOf("not stated"), ["not stated", ""]);
  assert.deepEqual(J.germanOf(""), ["not stated", ""]); assert.deepEqual(J.germanOf("nice to have"), ["no", ""]);
  // nothing from the AI: the ad's own words
  assert.deepEqual(J.germanOf("", "Sehr gute Deutschkenntnisse (C1) erforderlich."), ["yes", "C1"]);
  assert.deepEqual(J.germanOf("not stated", "Fließend Deutsch in Wort und Schrift."), ["yes", "B2"]);
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
  assert.deepEqual(group.body.commands.map((x) => x.command), ["jobs", "waitinglist", "tracker", "german", "nudge", "cv", "jobreport", "skills", "finds", "casual"]);
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
  const ask = c.find((x) => x.method === "sendMessage" && /only have the short version/.test(x.body.text));
  await ok("its cover letter button finds the job; the ad is short, so it asks for it, and Write anyway fits too", () => {
    assert.ok(ask);
    assert.ok(ask.body.reply_markup.inline_keyboard.flat().every((b) => new TextEncoder().encode(b.callback_data).length <= 64));
  });
  c = await tap(ask.body.reply_markup.inline_keyboard[0][0].callback_data);
  await ok("…Write anyway writes it, and the letter's buttons fit too", () => {
    const m = c.find((x) => x.method === "sendMessage" && /Cover letter for/.test(x.body.text));
    assert.match(m.body.text, /Cover letter for Diba<\/b> · AgentixLake/);
    assert.ok(m.body.reply_markup.inline_keyboard.flat().every((b) => new TextEncoder().encode(b.callback_data).length <= 64));
  });
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

console.log("\n8. German: what an ad asks for, and each person's limit");
await ok("read from the ad's own words, the way real ads put it", () => {
  const r = (t, ai) => J.germanLabel(J.germanRank(ai, t));
  assert.equal(r("Sehr gute Deutschkenntnisse in Wort und Schrift , Englischkenntnisse sind von Vorteil"), "B2");   // C1 only when the ad names it
  assert.equal(r("Fluent in German (min. C2) Professional proficiency in English"), "C2");
  assert.equal(r("Language skills: Fluent German (C2) for customer communication, and solid English"), "C2");
  assert.equal(r("Ihr Profil\nDeutsch auf C1/C2 Niveau\nSQL"), "C1");
  assert.equal(r("Gute Deutschkenntnisse, sehr gute Polnischkenntnisse"), "B2");
  assert.equal(r("Full professional fluency in English and German (written and spoken)"), "B2");
  assert.equal(r("You speak fluent German and English, more languages are a plus"), "B2");
  assert.equal(r("you communicate well in both English and German"), "B2");
  assert.equal(r("Proficiency in spoken and written German and professional working proficiency in English"), "B2");
  // not required
  assert.equal(r("Fließende Deutschkenntnisse Von Vorteil\nErfahrung mit KI"), "not required");
  assert.equal(r("You speak English fluently C1 - German is a plus but not required."), "not required");
  assert.equal(r("Language Skills: Fluent in English (C1); German or Polish proficiency is a strong advantage."), "not required");
  assert.equal(r("Sprachkenntnisse: Gute Deutsch- oder Englischkenntnisse für die Abstimmung"), "not required");
  // not about the language at all
  assert.equal(r("As one of the leading German HealthTech companies, we connect two-thirds of all German hospitals"), "not stated");
  assert.equal(r("Deutschlandticket, Urban Sports Club, German language learning budget"), "not stated");
  assert.equal(r("Kenntnisse im deutschen Arbeitsrecht. Remote in Deutschland."), "not stated");
  // the ad says nothing: the AI's note
  assert.equal(r("SQL, Python", "C1"), "B2"); assert.equal(r("SQL", "fluent"), "B2");   // the AI's C1 alone: B2 assert.equal(r("SQL", "not stated"), "not stated");
  assert.equal(r("SQL", "not needed"), "not required"); assert.equal(r("SQL", "nicht nötig"), "not required");
  // the ad's words win over the AI's
  assert.equal(r("Deutsch auf C1-Niveau", "B2"), "C1"); assert.equal(r("German is a plus", "C1"), "not required");
});
{
  const [DB8, st8, E8] = await fresh();
  const tg8 = new Telegram("T", "-100");
  const say8 = async (text) => { net.tg = []; await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" },
    body: JSON.stringify({ message: { text, from: { id: 555 }, chat: { id: -100 }, message_thread_id: 965, is_topic_message: true } }) }), E8); return net.tg; };
  let c = await say8("/german");
  await ok("/german: each person's limit (no limit at first) and a row of buttons each", () => {
    const m = c.find((x) => x.method === "sendMessage");
    assert.match(m.body.text, /🗣 <b>German<\/b>[\s\S]*Diba: <b>no limit<\/b>/);
    assert.deepEqual(m.body.reply_markup.inline_keyboard[0].map((b) => b.text), ["👩‍💻 Not required", "👩‍💻 B1", "👩‍💻 B2", "👩‍💻 C1", "• 👩‍💻 No limit •"]);
  });
  c = await say8("/german diba b2");
  await ok("/german diba b2: saved, and the card shows it", async () => {
    assert.equal(await st8.kvGet("jobs_german:diba"), "b2");
    assert.match(c.find((x) => /Diba: up to B2/.test(x.body.text)).body.text, /up to B2/);
  });
  await J.jobsStep(E8, st8, tg8);                                   // makes the table
  // two posted jobs and one on the waiting list: one asks for C1 in its text, one the AI read as fluent, one fits
  const put = (id, status, text, german, msg) => DB8.raw.prepare(`INSERT INTO jobs (id,dkey,source,title,company,place,url,remote,kind,text,status,person,facts,attempts,first_seen,posted_at,msg_id)
    VALUES (?,?,?,?,?,?,?,0,'werkstudent',?,?,'diba',?,0,1,1,?)`).run(id, id, "LinkedIn", "Werkstudent Data " + id, "Firma", "Berlin", "https://x/" + id, text, status,
    JSON.stringify({ for: "diba", kind: "werkstudent", german }), msg);
  put("li:c1", "posted", "Dein Profil: Deutsch auf C1/C2 Niveau, SQL.", "not stated", 4001);
  put("li:fl", "approved", null, "fluent German", null);
  put("li:ok", "posted", "Gute Deutschkenntnisse, SQL.", "B2", 4002);
  net.tg = []; await J.jobsStep(E8, st8, tg8);
  await ok("an ad naming C1 over her B2 limit: card deleted, skipped with the reason; 'fluent' from the AI alone stays on her waiting list", () => {
    assert.deepEqual([row(DB8, "li:c1").status, row(DB8, "li:c1").why], ["skipped", "German C1"]);
    assert.deepEqual([row(DB8, "li:fl").status, row(DB8, "li:fl").why], ["approved", null]);
    assert.equal(row(DB8, "li:ok").status, "posted");
    assert.ok(net.tg.some((x) => x.method === "deleteMessage" && x.body.message_id === 4001));
    assert.ok(!net.tg.some((x) => x.method === "deleteMessage" && x.body.message_id === 4002));
  });
  await ok("the card shows the German read from the ad", () => {
    assert.match(J.card(row(DB8, "li:ok"), JOBS), /🗣 German: B2\n/);
    assert.match(J.card({ ...row(DB8, "li:ok"), text: "SQL", facts: JSON.stringify({ kind: "werkstudent" }) }, JOBS), /🗣 German: not stated\n/);
  });
  // a new job asking for C1: never posted
  const E9 = { ...E8, INGEST_SECRET: "s9" };
  const hand9 = (body) => worker.fetch(new Request("https://w/ingest/jobs", { method: "POST", headers: { "X-Ingest-Secret": "s9", "Content-Type": "application/json" }, body: JSON.stringify(body) }), E9);
  await hand9({ op: "add", jobs: [{ id: "ba:c1new", source: "Jobbörse", title: "Werkstudent Data Analyst", company: "Neu GmbH", place: "Berlin", url: "https://x/n", text: "Verhandlungssicheres Deutsch (C1). SQL." }] });
  for (let i = 0; i < 3; i++) await J.jobsStep(E8, st8, tg8);
  await ok("a new job asking for C1 isn't posted at all", () => {
    assert.equal(row(DB8, "ba:c1new").status, "skipped"); assert.equal(row(DB8, "ba:c1new").why, "German C1");
  });
  // LinkedIn: held back for its page, which the Mac sends
  await hand9({ op: "add", jobs: [{ id: "li:777", source: "LinkedIn", title: "Werkstudent Data Science", company: "LI GmbH", place: "Berlin", url: "https://www.linkedin.com/jobs/view/777" }] });
  await J.jobsStep(E8, st8, tg8);
  await ok("a new LinkedIn job waits for its page (up to 30 minutes) before it's matched", async () => {
    assert.equal(row(DB8, "li:777").status, "new");
    const need = await (await hand9({ op: "needtext", jobs: [] })).json();
    assert.ok(need.ids.includes("li:777"));
    assert.equal(need.ids[0], "li:fl");                                 // the waiting list's page first
  });
  await hand9({ op: "text", jobs: [{ id: "li:777", text: "Sehr gute Deutschkenntnisse in Wort und Schrift", kind: "Teilzeit" }] });
  for (let i = 0; i < 3; i++) await J.jobsStep(E8, st8, tg8);
  await ok("C1 or C2 only when the ad names it: very good / excellent / sehr gut / fließend / native German are B2", () => {
    for (const t of ["You have very good German and good English communication skills.", "Excellent German.", "Very good command of German", "very strong German skills",
      "Sehr gute Deutschkenntnisse", "Verhandlungssicheres Deutsch", "Deutsch als Muttersprache", "Good German skills."])
      assert.equal(J.germanLabel(J.germanRank("", t)), "B2", t);
    assert.equal(J.germanLabel(J.germanRank("", "Sehr gute Deutschkenntnisse (mind. C1)")), "C1");
    assert.equal(J.germanLabel(J.germanRank("", "We are an excellent German company with English as our working language.")), "not stated");
    assert.equal(J.germanLabel(J.germanRank("", "Very good knowledge of the German market.")), "not stated");
    assert.equal(J.germanLabel(J.germanRank("", "You speak very good German.")), "B2");
  });
  await ok("…its page says 'sehr gute Deutschkenntnisse' but names no level: B2, so it isn't left out for German", () => {
    assert.notEqual(row(DB8, "li:777").why, "German C1"); assert.notEqual(row(DB8, "li:777").status, "new");
  });
  // a LinkedIn job whose page didn't come within the 30 minutes: matched on its title, and still gets its page later
  await hand9({ op: "add", jobs: [{ id: "li:888", source: "LinkedIn", title: "Werkstudent Data Analytics", company: "Spät GmbH", place: "Berlin", url: "https://www.linkedin.com/jobs/view/888" }] });
  DB8.raw.prepare("UPDATE jobs SET first_seen = first_seen - 3600 WHERE id='li:888'").run();
  for (let i = 0; i < 3; i++) await J.jobsStep(E8, st8, tg8);
  await ok("a LinkedIn job matched before its page came: no description stored, so it still counts as missing one", async () => {
    assert.notEqual(row(DB8, "li:888").status, "new"); assert.equal(row(DB8, "li:888").text, null);
    assert.ok((await (await hand9({ op: "needtext", jobs: [] })).json()).ids.includes("li:888"));
  });
  DB8.raw.prepare("UPDATE jobs SET text='' WHERE id='li:888'").run();          // how such jobs were stored before
  await ok("…an empty description counts as none too, and the page is saved: the answer says how many really were", async () => {
    assert.ok((await (await hand9({ op: "needtext", jobs: [] })).json()).ids.includes("li:888"));
    assert.equal((await (await hand9({ op: "text", jobs: [{ id: "li:888", text: "Aufgaben: SQL und Python. Englisch fließend." }] })).json()).saved, 1);
    assert.match(row(DB8, "li:888").text, /Aufgaben: SQL/);
    assert.equal((await (await hand9({ op: "text", jobs: [{ id: "li:888", text: "again" }] })).json()).saved, 0);
  });
  c = await say8("/german diba any");
  await ok("/german diba any: no limit again", async () => assert.equal((await J.germanLimits(st8, JOBS)).diba, 6));
}

console.log("\n9. remote jobs in other cities, hybrid ones close by");
await ok("the Jobbörse: each search also once for all of Germany (no city), keeping home-office jobs only", async () => {
  const qs = J.searchesFor(JOBS, ["diba"]);
  assert.ok(qs.some((q) => q.wo === "" && q.r === 0));
  assert.equal(qs.filter((q) => q.wo === "").length, JOBS.people.find((p) => p.id === "diba").searches.length);
  assert.ok(!J.searchesFor({ ...JOBS, remote: false }, ["diba"]).some((q) => q.wo === ""), "remote off: the cities only");
});
await ok("the matcher is told where they can work: their cities, from home, hybrid only in the cities close by", async () => {
  const cfgN = normalize({ ...CONFIG, jobs: { ...CONFIG.jobs, near: ["Dresden", "Leipzig"] } });
  const p = J.matchPrompt(cfgN.jobs);
  assert.match(p, /They live in Berlin or Cottbus and can work there on-site, or remotely from home\. A job elsewhere in Germany fits only if it's fully remote or asks for presence rarely \(a few days a month at most\), or if it's hybrid in Berlin, Cottbus, Dresden, Leipzig\./);
  assert.match(p, /onsite: where the work happens and how often in person/);
  assert.ok(!/They live in/.test(J.matchPrompt({ ...cfgN.jobs, remote: false })));
});
await ok("the card says where and how often in person", () => {
  const r = { id: "ba:x", title: "Werkstudent Data", company: "Firma", place: "München · home office possible", source: "Jobbörse", url: "https://x", status: "posted",
    person: "diba", text: "", facts: JSON.stringify({ kind: "werkstudent", why: "fits", onsite: "remote, on-site 1 day/month in Munich" }) };
  assert.match(J.card(r, JOBS), /\n\n🏠 Where: remote, on-site 1 day\/month in Munich\n🗣 German: not stated/);
});

console.log("\n10. workingstudentjobs.de");
{
  const WS = { data: [
    { id: "a1", title: "Werkstudent Data Analytics (m/w/d)", company: { name: "Finanz GmbH" }, location: { city: "Berlin" }, url: "https://www.workingstudentjobs.de/jobs/a1", apply_url: "https://finanz.example/jobs/a1",
      types: ["working_student"], field: "tech", sub_field: "data-analytics", working_mode: "hybrid", skills: ["SQL", "Python"],
      languages: { german: "required", english: "required" }, details: { german_level: { level: "fluent", cefr: "C1" }, hours_per_week: { min: 15, max: 20 }, remote_days_max: 2, start: { asap: true } } },
    { id: "a2", title: "Working Student Data Science", company: { name: "Startup" }, location: { city: "Berlin" }, url: "https://www.workingstudentjobs.de/jobs/a2",
      types: ["working_student"], working_mode: "onsite", languages: { german: "not_required", english: "required" }, details: {} },
    { id: "a3", title: "Praktikum BI", company: { name: "Leipzig AG" }, location: { city: "Leipzig" }, url: "https://x/a3",
      types: ["internship"], working_mode: "onsite", languages: { german: "required" }, details: { german_level: { level: "good", cefr: null } } },
  ] };
  await ok("the pages, in turn: the cities (Werkstudent and internship), the cities close by, all of Germany in tech", () => {
    const j = normalize({ ...CONFIG, jobs: { ...CONFIG.jobs, workingstudentjobs: true, near: ["Leipzig"] } }).jobs;
    assert.deepEqual(J.wsjPages(j).map((p) => `${p.q} ${p.keep}`), [
      "city=berlin&type=working_student all", "city=berlin&type=internship all", "city=cottbus&type=working_student all", "city=cottbus&type=internship all",
      "city=leipzig&type=working_student hybrid", "type=working_student&field=tech remote", "type=internship&field=tech remote"]);
  });
  await ok("a job: title, company, place with how it's worked, link, kind, and the employer's German as words the reader knows", () => {
    const [a, b] = J.parseWsj(WS, "all");
    assert.deepEqual([a.id, a.source, a.company, a.place, a.kind, a.remote], ["ws:a1", "workingstudentjobs.de", "Finanz GmbH", "Berlin · hybrid", "werkstudent", false]);
    assert.equal(a.url, "https://finanz.example/jobs/a1"); assert.equal(b.url, "https://www.workingstudentjobs.de/jobs/a2");   // the employer's page when there is one
    assert.match(a.text, /Deutschkenntnisse auf C1-Niveau\.\nEnglish required\.\n15-20 hours a week\.\nHybrid, up to 2 days a week remote\./);
    assert.equal(J.germanLabel(J.germanRank("", a.text)), "C1");
    assert.equal(J.germanLabel(J.germanRank("", b.text)), "not required");
    assert.equal(J.germanLabel(J.germanRank("", J.parseWsj(WS, "all")[2].text)), "B2");
    assert.equal(J.parseWsj(WS, "all")[2].kind, "internship");
  });
  await ok("close by: hybrid and remote only; all of Germany: remote only", () => {
    assert.deepEqual(J.parseWsj(WS, "hybrid").map((x) => x.id), ["ws:a1"]);
    assert.deepEqual(J.parseWsj(WS, "remote").map((x) => x.id), []);
  });
  const [DBw, stw, Ew] = await fresh({ ...CONFIG, jobs: { ...CONFIG.jobs, workingstudentjobs: true } });
  const f0 = globalThis.fetch, asked = [];
  globalThis.fetch = async (u, i) => (String(u).startsWith("https://www.workingstudentjobs.de/") ? (asked.push(String(u)), Response.json(WS)) : f0(u, i));
  await stw.kvSet("jobs_german:diba", "b2");
  for (let i = 0; i < 4; i++) await J.jobsStep(Ew, stw, tg);
  globalThis.fetch = f0;
  await ok("one page per tick, in turn, with ref=neustart; its jobs matched like the rest - the C1 one left out for Diba (B2)", () => {
    assert.equal(asked.length, 4); assert.ok(asked.every((u) => /&ref=neustart$/.test(u)));
    assert.equal(asked[0], "https://www.workingstudentjobs.de/api/v1/jobs?city=berlin&type=working_student&ref=neustart");
    assert.equal(row(DBw, "ws:a1").status, "skipped"); assert.equal(row(DBw, "ws:a1").why, "German C1");
    assert.notEqual(row(DBw, "ws:a2").status, "skipped");
  });
}

console.log("\n11. other languages, and letters that read like a person wrote them");
await ok("a job needing a language nobody searching speaks is left out (Persian counts for someone who speaks it)", async () => {
  const j = normalize({ ...CONFIG, jobs: { ...CONFIG.jobs, people: CONFIG.jobs.people.map((p) => p.id === "diba" ? { ...p, languages: ["persian"] } : p) } }).jobs;
  assert.equal(J.jobRejectReason("Intern, Data Labeler (Spanish Speaker) - (Global Discovery, Consumer)", j, ["diba"]), "needs Spanish");
  assert.equal(J.jobRejectReason("Working Student with Thai (m/f/d) - Data Annotation", j, ["diba"]), "needs Thai");
  assert.equal(J.jobRejectReason("Data Analyst (Persian speaker)", j, ["diba"]), null);
  assert.deepEqual(J.otherLanguages("Werkstudent Data", "Your profile: fluent French is required. SQL.", ["german", "english"]), ["french"]);
  assert.deepEqual(J.otherLanguages("Werkstudent Data", "Spanish or French is a plus.", ["german", "english"]), []);
  assert.deepEqual(J.otherLanguages("Werkstudent Data", "We work with Polish clients. SQL, Python.", ["german", "english"]), []);
});
const L = await import(SRC + "letter.ts");
await ok("letters: no dashes as punctuation, the stock phrases and the even rhythm are caught for free", () => {
  const l = L.parseLetter(JSON.stringify({ lang: "de", subject: "Bewerbung", body: "Ihr Team baut Dashboards — genau das kann ich. Und zwar gut – seit Jahren - mit SQL.", why: "x" }));
  assert.ok(!/[—–]| - /.test(l.body), l.body);
  const even = { ...l, body: "Ich habe zwei Jahre Daten analysiert und Berichte erstellt. Ich habe Dashboards mit SQL gebaut und gepflegt. Ich habe Modelle mit Python trainiert und geprüft. Ich habe Tests für Produkte ausgewertet und erklärt. Ich arbeite gern im Team mit vielen Leuten." };
  assert.ok(L.letterIssues(even, "SQL Python", "", []).some((x) => /all about the same length/.test(x)));
  assert.ok(L.letterIssues({ ...l, body: "Mit großem Interesse und Leidenschaft bewerbe ich mich, nicht nur wegen der Daten." }, "", "", []).length >= 3);
});
await ok("the writer is told the humanizer's rules", () => {
  const sys = L.letterSystem({ name: "Diba", full_name: "Diba T", summary: "x", cv: "y", availability: "20 h a week", skills: [] });
  assert.match(sys, /A cover letter is not the CV/); assert.match(sys, /No dashes as punctuation/); assert.match(sys, /nicht nur \.\.\., sondern auch/);
  assert.match(sys, /mix very short sentences with longer ones/); assert.match(sys, /body starts lowercase/);
});

console.log("\n12. a short ad: asked for, pasted in; 🚫 Closed; a workingstudentjobs.de job taken down");
{
  const [DBp, stp, Ep] = await fresh({ ...CONFIG, jobs: { ...CONFIG.jobs, workingstudentjobs: true } });
  await J.jobsStep(Ep, stp, tg);                                  // makes the table
  await stp.kvSet("jobs_german:diba", "b2");
  const t0 = Math.floor(Date.now() / 1000);
  const add = (id, msg, extra = {}) => DBp.raw.prepare(
    "INSERT INTO jobs (id, dkey, source, title, company, place, url, remote, kind, text, status, person, facts, first_seen, posted_at, msg_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, id, "workingstudentjobs.de", extra.title ?? "Werkstudent Portfolioanalyse (m/w/d)", "LEAG", "Cottbus", "https://www.workingstudentjobs.de/jobs/x",
      0, "werkstudent", "Werkstudent Portfolioanalyse\nSkills: Python, SQL.\nDeutschkenntnisse erforderlich.", "posted", "diba",
      JSON.stringify({ for: "diba", kind: "werkstudent", why: "fits", gaps: [], german: "", skills: ["Python"] }), t0 - 3 * 86400, extra.posted ?? t0 - 2 * 86400, msg);
  add("ws:short", 901); add("ws:c1", 902, { title: "Werkstudent Energiehandel" }); add("ws:gone", 903); add("ws:still", 904);
  const post = async (body) => { net.tg = []; await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" }, body: JSON.stringify(body) }), Ep); return net.tg; };
  const tap = (data, message_id = 901) => post({ callback_query: { id: "q", data, from: { id: 555 }, message: { chat: { id: -100 }, message_id } } });
  const say = (text, reply_to, message_id = 950) => post({ message: { message_id, text, from: { id: 555 }, chat: { id: -100 },
    reply_to_message: { message_id: reply_to, from: { id: 42, is_bot: true } } } });
  const AD = "Wir suchen ab sofort einen Werkstudent Portfolioanalyse Renewables und Flexibilität (m/w/d) im Bereich Trading & Optimierung. Referenznummer: 324\n" +
    "Deine Aufgaben: Automatisierung wiederkehrender Analyseprozesse, Entwicklung von Dashboards, Aufbereitung energiewirtschaftlicher Daten.\n" +
    "Unser Match: Programmiererfahrung in Python (numpy, pandas, plotly), gute SQL-Kenntnisse, sehr gute Excel-Kenntnisse. Du kommunizierst sicher in Deutsch und Englisch.\n" +
    "Ansprechpartner: Anna Beispiel, Personalmanagement.";

  const before = net.letters.length;
  let c = await tap("jb:letter:diba:ws:short");
  const ask = c.find((x) => x.method === "sendMessage");
  await ok("✍️ on a job with only the feed's short text: no letter, it asks for the ad, under the card, with Write anyway", async () => {
    assert.equal(net.letters.length, before);
    assert.match(ask.body.text, /only have the short version[\s\S]*Reply to this message with the ad's text/);
    assert.equal(ask.body.reply_to_message_id, 901);
    assert.deepEqual(ask.body.reply_markup.inline_keyboard.flat().map((b) => b.text), ["✍️ Write anyway"]);
    assert.match(c.find((x) => x.method === "answerCallbackQuery").body.text, /Reading the ad/);
  });
  const askId = msgId;                                            // the id the fake Telegram gave that message
  c = await say("hier ist sie", askId);
  await ok("a reply too short to be an ad, under the request: it says to paste the whole ad", () => {
    assert.match(c[0].body.text, /only 12 characters/); assert.equal(net.letters.length, before);
  });
  c = await say("cool, danke!", 904);
  await ok("a short remark under a job card is just chatter: no answer", () => assert.equal(c.length, 0));
  c = await say("hallo zusammen", 777);
  await ok("a reply to some other bot message: no answer", () => assert.equal(c.length, 0));

  c = await say(AD, askId);
  await ok("the ad pasted as a reply: saved as the job's text, and the letter written from it", () => {
    assert.equal(row(DBp, "ws:short").text, AD);
    assert.match(c.find((x) => x.method === "sendMessage").body.text, /Got the ad \(\d+ characters\)/);
    const l = net.letters.at(-1);
    assert.equal(net.letters.length, before + 1);
    assert.match(l.user, /Referenznummer: 324/); assert.match(l.user, /Anna Beispiel/);
    assert.ok(c.some((x) => x.method === "sendMessage" && /Cover letter for Diba/.test(x.body.text)));
    assert.ok(c.some((x) => x.method === "sendDocument"));        // the PDF
  });
  c = await tap("jb:letter:diba:ws:short");
  await ok("…and ✍️ on that job now writes straight away", () => {
    assert.equal(net.letters.length, before + 2); assert.ok(!c.some((x) => /short version/.test(x.body?.text ?? "")));
  });
  c = await tap("jb:wany:diba:ws:still", 904);
  await ok("✍️ Write anyway writes a letter from the short text", () => {
    assert.equal(net.letters.length, before + 3); assert.ok(c.some((x) => /Cover letter for Diba/.test(x.body?.text ?? "")));
  });

  c = await say(AD.replace("sicher in Deutsch", "verhandlungssicher auf C1-Niveau in Deutsch"), 902, 951);
  await ok("an ad pasted under a card that asks for more German than her limit: the card comes down, no letter", () => {
    assert.equal(row(DBp, "ws:c1").status, "skipped"); assert.equal(row(DBp, "ws:c1").why, "German C1");
    assert.ok(c.some((x) => x.method === "deleteMessage" && x.body.message_id === 902));
    assert.match(c.find((x) => x.method === "sendMessage").body.text, /asks for German C1, more than Diba can work in/);
    assert.equal(net.letters.length, before + 3);
  });

  c = await tap("jb:closed:-:ws:still", 904);
  await ok("🚫 Closed: the job counts as closed by the employer, the card turns into one line with an Undo", () => {
    assert.equal(row(DBp, "ws:still").status, "expired"); assert.equal(row(DBp, "ws:still").why, "closed by the employer");
    const e = c.find((x) => x.method === "editMessageText");
    assert.match(e.body.text, /^🚫 Ad for <b>Werkstudent Portfolioanalyse \(m\/w\/d\)<\/b> at <b>LEAG<\/b> marked as closed/);
    assert.deepEqual(e.body.reply_markup.inline_keyboard.flat().map((b) => b.text), ["↩️ Undo"]);
  });
  c = await tap("jb:undo:-:ws:still", 904);
  await ok("…↩️ Undo puts it back, with its buttons", () => {
    assert.equal(row(DBp, "ws:still").status, "posted"); assert.equal(row(DBp, "ws:still").why, null);
    assert.ok(c.find((x) => x.method === "editMessageText").body.reply_markup.inline_keyboard.flat().some((b) => b.text === "🚫 Closed"));
  });

  // the daily look-up: the site's API answers 404 for a job it took down
  DBp.raw.prepare("UPDATE jobs SET status='posted', checked_at=NULL WHERE id IN ('ws:gone','ws:still')").run();
  DBp.raw.prepare("UPDATE jobs SET status='skipped' WHERE id='ws:short'").run();
  const f0 = globalThis.fetch, looked = [];
  globalThis.fetch = async (u, i) => {
    u = String(u);
    if (u.startsWith("https://www.workingstudentjobs.de/api/v1/jobs/")) { looked.push(u); return new Response("{}", { status: u.endsWith("/gone") ? 404 : 200 }); }
    if (u.startsWith("https://www.workingstudentjobs.de/")) return Response.json({ data: [] });
    return f0(u, i);
  };
  net.tg = [];
  await J.jobsStep(Ep, stp, tg);
  await ok("workingstudentjobs.de jobs are looked up daily: one its API no longer has comes down, the other stays", () => {
    assert.ok(looked.some((u) => u.endsWith("/api/v1/jobs/gone"))); assert.ok(looked.some((u) => u.endsWith("/api/v1/jobs/still")));
    assert.equal(row(DBp, "ws:gone").status, "expired"); assert.equal(row(DBp, "ws:gone").why, "no longer listed");
    assert.ok(net.tg.some((x) => x.method === "deleteMessage" && x.body.message_id === 903));
    assert.equal(row(DBp, "ws:still").status, "posted"); assert.ok(row(DBp, "ws:still").checked_at);
  });
  looked.length = 0;
  await J.jobsStep(Ep, stp, tg);
  globalThis.fetch = f0;
  await ok("…and not again until a day later", () => assert.equal(looked.filter((u) => /\/api\/v1\/jobs\/(gone|still)$/.test(u)).length, 0));
}

console.log("\n13. ✏️ Change something: the letter rewritten from what they say");
{
  const [DBc, stc, Ec] = await fresh();
  await J.jobsStep(Ec, stc, tg);                                  // makes the table
  const t0 = Math.floor(Date.now() / 1000);
  DBc.raw.prepare("INSERT INTO jobs (id, dkey, source, title, company, place, url, remote, kind, text, status, person, facts, first_seen, posted_at, msg_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("ba:ch1", "ch1", "Jobbörse", "Werkstudent Data (m/w/d)", "Change GmbH", "Berlin", "https://x/ch1", 0, "werkstudent",
      "Aufgaben: Dashboards mit SQL und Python bauen. ".repeat(30), "posted", "diba", JSON.stringify({ kind: "werkstudent", german: "B2", skills: ["SQL"] }), t0, t0, 1201);
  const post = async (body) => { net.tg = []; await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" }, body: JSON.stringify(body) }), Ec); return net.tg; };
  const tap = (data, message_id) => post({ callback_query: { id: "q", data, from: { id: 555 }, message: { chat: { id: -100 }, message_id } } });
  const say = (text, reply_to, message_id, from = 555) => post({ message: { message_id, text, from: { id: from }, chat: { id: -100 },
    reply_to_message: { message_id: reply_to, from: { id: 42, is_bot: true } } } });
  const sentOf = (c, re) => c.find((x) => x.method === "sendMessage" && re.test(x.body.text ?? ""));

  let c = await tap("jb:letter:diba:ba:ch1", 1201);
  const saved = async () => JSON.parse(await stc.kvGet("letter:ba:ch1:diba"));
  const { msg: letterAt, pdf: pdfAt } = await saved();
  const letter = sentOf(c, /Cover letter for Diba/);
  const menu = (await tap(letter.body.reply_markup.inline_keyboard.flat().find((b) => b.text === "✏️ Change the letter").callback_data, letterAt))
    .find((x) => x.method === "editMessageText").body.reply_markup.inline_keyboard;
  await ok("its change menu has ✏️ Change something (in their own words) above ⬅️ Back", () => {
    assert.deepEqual(menu.at(-2).map((b) => b.text), ["✏️ Change something"]); assert.deepEqual(menu.at(-1).map((b) => b.text), ["⬅️ Back"]);
  });
  c = await tap(menu.at(-2)[0].callback_data, letterAt);
  const askAt = msgId;
  await ok("✏️ asks what should change, as a reply, with examples; no AI call yet", () => {
    assert.match(sentOf(c, /What should change/).body.text, /Reply to this message in your own words/);
    assert.ok(!c.some((x) => x.method === "deleteMessage"));
  });
  const edits = net.edits.length;
  c = await say("schreib rein, dass sie 10 Jahre Erfahrung hat", askAt, 1299, 777);
  await ok("a reply to ✏️'s question from someone who didn't tap it: nothing happens", () => {
    assert.equal(net.edits.length, edits); assert.equal(c.length, 0);
  });
  c = await say("erwähne, dass ich im Bachelor ein Churn-Modell gebaut habe", askAt, 1300);
  const second = sentOf(c, /Cover letter for Diba/);
  await ok("her reply: the old letter and PDF come down, a new letter and PDF go out under her reply", () => {
    assert.equal(net.edits.length, edits + 1);
    assert.match(net.edits.at(-1).todo, /Churn-Modell/);
    const del = c.filter((x) => x.method === "deleteMessage").map((x) => x.body.message_id);
    assert.ok(del.includes(letterAt) && del.includes(pdfAt) && del.includes(askAt), JSON.stringify(del));
    assert.ok(second); assert.equal(second.body.reply_to_message_id, 1300);
    assert.ok(c.some((x) => x.method === "sendDocument"));
    assert.ok(!c.some((x) => x.method === "sendDocument" && /CV/.test(x.body.caption ?? "")));   // the CV isn't sent again
  });
  const key = await saved(), second_at = key.msg;
  await ok("…what she said is kept with the letter, which knows its new message", () => {
    assert.deepEqual(key.notes, ["erwähne, dass ich im Bachelor ein Churn-Modell gebaut habe"]); assert.notEqual(second_at, letterAt);
  });
  c = await say("sieht gut aus, danke!", second_at, 1301);
  await ok("a reply straight to the letter is just a comment: no AI, nothing deleted", () => {
    assert.equal(net.edits.length, edits + 1); assert.equal(c.length, 0);
  });
  c = await say("noch eine Änderung", askAt, 1303);
  await ok("…and the question, once answered, doesn't take a second reply", () => assert.equal(net.edits.length, edits + 1));
  c = await tap("jb:wtell:diba:ba:ch1", second_at);
  c = await say("lass den Teil über A/B-Tests weg", msgId, 1304);
  await ok("a second ✏️ works the same, and adds to what she said before", async () => {
    assert.ok(sentOf(c, /Cover letter for Diba/)); assert.match(net.edits.at(-1).todo, /A\/B-Tests/);
    assert.equal((await saved()).notes.length, 2);
  });
  const letters = net.letters.length;
  c = await tap("jb:wredo:diba:ba:ch1", (await saved()).msg);
  await ok("🔄 New version keeps what she said: it's in the writer's prompt", () => {
    assert.equal(net.letters.length, letters + 1);
    assert.match(net.letters.at(-1).user, /FROM THE APPLICANT[\s\S]*Churn-Modell[\s\S]*A\/B-Tests/);
  });
  const at = (await saved()).msg;
  c = await tap("jb:wsent:diba:ba:ch1", at);
  await ok("✅ Fine, I sent it: in the tracker as applied by her; the job card turns into its one line with Undo; the letter says Sent", () => {
    const r = DBc.raw.prepare("SELECT status, person, applied_at, msg_id FROM jobs WHERE id='ba:ch1'").get();
    assert.deepEqual([r.status, r.person, r.msg_id], ["applied", "diba", null]); assert.ok(r.applied_at);
    const card = c.find((x) => x.method === "editMessageText" && x.body.message_id === 1201);
    assert.match(card.body.text, /^✅ Ad for <b>Werkstudent Data \(m\/w\/d\)<\/b> at <b>Change GmbH<\/b> moved to the tracker \(applied by Diba\)/);
    assert.deepEqual(card.body.reply_markup.inline_keyboard.flat().map((b) => b.text), ["↩️ Undo"]);
    const l = c.find((x) => x.method === "editMessageText" && x.body.message_id === at);
    assert.match(l.body.text, /✅ <b>Sent<\/b> · it's in the \/tracker$/); assert.deepEqual(l.body.reply_markup.inline_keyboard, []);
    assert.match(c.find((x) => x.method === "answerCallbackQuery").body.text, /Moved to the tracker/);
  });
  c = await tap("jb:undo:-:ba:ch1", 1201);
  await ok("…and its Undo puts the job back where it was", () =>
    assert.equal(DBc.raw.prepare("SELECT status FROM jobs WHERE id='ba:ch1'").get().status, "posted"));
}

console.log("\n12. how far: only jobs an all-of-Germany search found");
await ok("an office job far away from an all-of-Germany search is left out; remote ones, the cities and the cities close by aren't", () => {
  const j = normalize({ ...CONFIG, jobs: { ...CONFIG.jobs, near: ["Dresden"] } }).jobs;
  const far = (place, extra = {}, f = {}) => J.tooFar({ place, remote: 0, text: "", wide: 1, ...extra }, f, j);
  assert.equal(far("Nürnberg"), "on-site in Nürnberg");
  assert.equal(far("München · hybrid", {}, { onsite: "hybrid, 2 days/week in Munich" }), "on-site in München");
  assert.equal(far("München", {}, { onsite: "fully remote" }), null);
  assert.equal(far("München · remote", { remote: 1, text: "Fully remote team" }), null);
  assert.equal(far("Dresden · hybrid"), null); assert.equal(far("Berlin"), null); assert.equal(far("Germany"), null);
  assert.equal(J.tooFar({ place: "Schönefeld", remote: 0, text: "", wide: 0 }, {}, j), null, "a city search's suburb stays");
});
await ok("the all-of-Germany searches mark what they find", () => {
  const WSJ = { data: [{ id: "r1", title: "Werkstudent Data", company: { name: "X" }, location: { city: "Hamburg" }, url: "u", types: ["working_student"], working_mode: "remote", details: {} }] };
  assert.equal(J.parseWsj(WSJ, "remote")[0].wide, true); assert.equal(J.parseWsj(WSJ, "all")[0].wide, false);
});

console.log("\n14. a long ad Telegram split in parts: one letter from all of it");
{
  const [DBs, sts, Es] = await fresh();
  await J.jobsStep(Es, sts, tg);                                  // makes the table
  const t0 = Math.floor(Date.now() / 1000);
  DBs.raw.prepare("INSERT INTO jobs (id, dkey, source, title, company, place, url, remote, kind, text, status, person, facts, first_seen, posted_at, msg_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("ba:sp1", "sp1", "Jobbörse", "Werkstudent Analytics (m/w/d)", "Split AG", "Berlin", "https://x/sp1", 0, "werkstudent",
      "kurz", "posted", "diba", JSON.stringify({ kind: "werkstudent", german: "B2", skills: ["SQL"] }), t0, t0, 1301);
  J.PASTE.waitMs = 30;
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const post = async (body) => { await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" }, body: JSON.stringify(body) }), Es, ctx); };
  const msg = (message_id, text, reply_to) => ({ message: { message_id, text, from: { id: 555 }, chat: { id: -100 },
    ...(reply_to ? { reply_to_message: { message_id: reply_to, from: { id: 42, is_bot: true } } } : {}) } });
  const P1 = "Aufgaben: Dashboards mit SQL bauen und Berichte für den Vertrieb. ".repeat(62);   // ~4000 characters, cut by Telegram
  const P2 = "Ansprechpartnerin: Erika Beispiel, Referenz 777.";
  net.tg = []; const before = net.letters.length;
  await post(msg(1400, P1, 1301));
  await post(msg(1401, P2));
  await Promise.all(waits);
  await ok("the reply and the plain message right after it: one letter, from both parts in order", () => {
    assert.equal(net.letters.length, before + 1);
    assert.match(net.letters.at(-1).user, /Erika Beispiel/);
    assert.equal(row(DBs, "ba:sp1").text, `${P1}\n${P2}`.slice(0, 6000));
    assert.equal(net.tg.filter((x) => x.method === "sendMessage" && /Got the ad/.test(x.body.text)).length, 1);
  });
  net.tg = []; waits.length = 0;
  await post(msg(1402, "danke, sieht gut aus"));
  await Promise.all(waits);
  await ok("a plain message later, with nothing being collected: ignored", () => {
    assert.equal(net.letters.length, before + 1); assert.equal(net.tg.length, 0);
  });
  await post(msg(1403, "cool, danke!", 1301));
  await ok("a short reply under a card isn't held back to wait for parts", () => assert.equal(waits.length, 0));
  J.PASTE.waitMs = 6000;
}

console.log(`\nall ${pass} jobs checks passed`);
