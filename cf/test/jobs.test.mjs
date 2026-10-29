// Offline tests for src/jobs.ts and its wiring. Synthetic Jobbörse and
// Arbeitnow answers, an in-memory D1, recorded OpenAI and Telegram calls.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

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
  baJob("10006", "Data Engineer (m/w/d)", "Vattenfall GmbH", "Berlin", "ARBEIT", true),
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
    if (/You write short, specific job applications/.test(body.messages[0].content)) {
      net.letters.push({ model: body.model, sys: body.messages[0].content, user });
      return Response.json({ choices: [{ message: { content: "Sehr geehrte Damen und Herren, … Mit freundlichen Grüßen, Diba Test" } }] });
    }
    const title = /Title: (.*)/.exec(user)[1];
    net.calls.push(title);
    assert.equal(body.model, "gpt-5.6-luna");
    const v = /Marketing/.test(title) ? { for: "none", reason: "marketing, not data science" }
      : /Frontend|React/.test(title) ? { for: "arman", kind: "werkstudent", why: "React Native work fits their React stack", gaps: [], german: "B2", hours: "20 h/week", start: "asap", deadline: "", lang: "de", skills: ["React", "TypeScript"] }
      : /Data Engineer/.test(title) ? { for: "diba", kind: "full-time", why: "SQL pipelines from her last job", gaps: ["Airflow - mention the Python automation"], german: "C1", hours: "40 h", start: "", deadline: "30.11.", lang: "de", skills: ["Airflow", "SQL", "Tableau"] }
      : { for: "diba", kind: "werkstudent", why: "Dashboards and SQL from her last job fit this analyst role", gaps: ["Tableau - mention Power BI and Metabase"], german: "B2", hours: "20 h/week", start: "asap", deadline: "15.11.", lang: /Working Student/.test(title) ? "en" : "de", skills: ["SQL", "Python", "Tableau"] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(v) } }] });
  }
  if (url.includes("api.telegram.org")) {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
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
const env = (DB) => ({ DB, OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-5.6-terra", FINDS_MODEL: "gpt-5.6-luna", TOPIC_JOBS: "965",
  TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "-100", TELEGRAM_OWNER_ID: "1000001", WEBHOOK_SECRET: "s" });
const tg = new Telegram("T", "-100");
const fresh = async () => {
  const DB = makeDB(); const st = new Store(DB);
  await st.kvSet("jobs_people", JSON.stringify(PEOPLE));
  await st.kvSet("profile", JSON.stringify({ about: { name: "Arman" }, style: {}, searches: [], filters: {} }));
  return [DB, st, env(DB)];
};
const sent = () => net.tg.filter((c) => c.method === "sendMessage");
const row = (DB, id) => ({ ...DB.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id) });

// ---------------------------------------------------------------- 1. rules
console.log("\n1. rules and dedupe (no AI)");
await ok("senior, lead, Ausbildung, freelance and off-topic titles are dropped", () => {
  for (const t of ["Senior Data Scientist (m/w/d)", "Lead Frontend Engineer", "Head of Data", "Teamleiter BI",
    "Ausbildung Fachinformatiker Daten- und Prozessanalyse", "Freelance React Developer", "Sachbearbeiter Buchhaltung (m/w/d)"])
    assert.ok(J.jobRejectReason(t), t);
  for (const t of ["Werkstudent Data Analyst (m/w/d)", "Working Student Machine Learning", "Junior Data Engineer",
    "Werkstudent Frontend Entwicklung React (m/w/d)", "Business Intelligence Analyst", "Werkstudent Softwareentwicklung"])
    assert.equal(J.jobRejectReason(t), null, t);
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
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE id='ba:10003'").get().n, 0);       // Ausbildung never stored
});
await ok("matching: Jobbörse jobs get their description fetched; Arbeitnow's comes with the feed", () => {
  assert.ok(net.details >= 2);
  assert.ok(net.calls.includes("Werkstudent Data Analyst (m/w/d)"));
});
for (let i = 0; i < 3; i++) await J.jobsStep(E, st, tg);
await ok("the AI's 'none' isn't posted; everything else is, in topic 965", () => {
  assert.equal(row(DB, "ba:10007").why, "ai: marketing, not data science");
  const cards = sent().filter((c) => c.body.text.startsWith("💼"));
  assert.equal(cards.length, 4);
  assert.ok(cards.every((c) => c.body.message_thread_id === 965));
});
const cardOf = (t) => sent().find((c) => c.body.text.startsWith("💼") && c.body.text.includes(t));
await ok("card: who it's for, Werkstudent, why, gaps, German level, hours, deadline - no rating", () => {
  const c = cardOf("Werkstudent Data Analyst").body.text;
  console.log("   card:\n     " + c.split("\n").join("\n     "));
  assert.match(c, /👩‍💻 For Diba · 🎓 Werkstudent/);
  assert.match(c, /Gaps: Tableau - mention Power BI and Metabase/);
  assert.match(c, /German: B2 · ⏱ 20 h\/week · 📅 start asap · ⏳ apply by 15\.11\./);
  assert.ok(!/⭐|\b\d+\/10\b/.test(c));
});
await ok("a full-time role is flagged for the student permit; Arman's React job is his", () => {
  assert.match(cardOf("Data Engineer").body.text, /⚠️ Full-time - more than a student permit allows/);
  assert.match(cardOf("Frontend").body.text, /🧑‍💻 For Arman/);
});
await ok("buttons on a new card: cover letter, applied, already applied, skip", () => {
  const kb = cardOf("Werkstudent Data Analyst").body.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.deepEqual(kb, ["✍️ Cover letter", "✅ Applied", "🔁 Already applied", "⏭ Skip"]);
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
  assert.match(l.sys, /Write in German/);
  assert.match(l.user, /Diba CV: two data/);
  assert.match(calls.find((c) => c.method === "sendMessage").body.text, /Cover letter for Diba[\s\S]*<pre>Sehr geehrte/);
});
calls = await press(`jb:applied:diba:${analyst}`);
await ok("✅ Applied (pressed by Diba, a group member): card edited in place, next stage's buttons", () => {
  const e = calls.find((c) => c.method === "editMessageText");
  assert.match(e.body.text, /✅ Applied by Diba · \d\d\.\d\d/);
  assert.deepEqual(e.body.reply_markup.inline_keyboard.flat().map((b) => b.text), ["🗓 Interview", "❌ Rejected", "🎉 Offer"]);
  assert.equal(row(DB, analyst).status, "applied");
});
calls = await press(`jb:interview:-:${analyst}`);
await ok("🗓 Interview → only Rejected / Offer left", () => {
  assert.equal(row(DB, analyst).status, "interview");
  assert.deepEqual(calls.find((c) => c.method === "editMessageText").body.reply_markup.inline_keyboard.flat().map((b) => b.text), ["❌ Rejected", "🎉 Offer"]);
});
await press(`jb:skip:-:ba:10004`);
await ok("⏭ Skip", () => assert.equal(row(DB, "ba:10004").status, "skipped"));
await press(`jb:already:diba:ba:10006`);
DB.raw.prepare("UPDATE jobs SET applied_at = ? WHERE id='ba:10006'").run(Math.floor(Date.now() / 1000) - 11 * 86400);
net.tg = [];
await J.jobsStep(E, st, tg);
await ok("no answer after 10 days: one reminder, as a reply to the card, with the answer buttons", () => {
  const m = sent().find((c) => /no answer from/.test(c.body.text));
  assert.ok(m); assert.ok(m.body.reply_to_message_id);
  assert.match(m.body.text, /Diba, no answer from <b>Vattenfall GmbH<\/b>/);
  assert.equal(row(DB, "ba:10006").reminded, 1);
});
net.tg = []; await J.jobsStep(E, st, tg);
await ok("…and only once", () => assert.ok(!sent().some((c) => /no answer from/.test(c.body.text))));

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
await ok("/jobs: the board per person, answered in the Jobs topic", () => {
  const t = calls[0].body.text;
  console.log("   /jobs ->\n     " + t.split("\n").join("\n     "));
  assert.match(t, /Diba<\/b>: \d+ open · 2 applied · 1 waiting · 1 interviews/);
  assert.equal(calls[0].body.message_thread_id, 965);
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

console.log(`\nall ${pass} jobs checks passed`);
