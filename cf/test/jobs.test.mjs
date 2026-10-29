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
    assert.ok(J.jobRejectReason(t), t);
  for (const t of ["Werkstudent Data Analyst (m/w/d)", "Working Student Machine Learning", "Junior Data Engineer",
    "Werkstudent Frontend Entwicklung React (m/w/d)", "Business Intelligence Analyst", "Werkstudent Softwareentwicklung"])
    assert.equal(J.jobRejectReason(t), null, t);
});
await ok("full-time listings are dropped unless the title says Werkstudent, intern, thesis or part-time", () => {
  assert.equal(J.jobRejectReason("Junior Data Engineer", undefined, "full-time"), "full-time");
  assert.equal(J.jobRejectReason("Data Analyst", undefined, "Full Time"), "full-time");
  for (const t of ["Werkstudent Data Analyst", "Working Student BI", "Praktikum Data Science", "Masterarbeit Machine Learning", "Data Analyst (Teilzeit)", "Data Engineer part-time"])
    assert.equal(J.jobRejectReason(t, undefined, "full-time"), null, t);
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
  assert.match(c, /\n\n👩‍💻 For Diba\n🎓 Werkstudent\n\n/);
  assert.match(c, /\n\nGaps:\n• Tableau - mention Power BI and Metabase\n\n/);
  assert.match(c, /German: B2 · ⏱ 20 h\/week · 📅 start asap · ⏳ apply by 15\.11\./);
  assert.ok(!/⭐|\b\d+\/10\b/.test(c));
});
await ok("a part-time job says so; Arman's React job is his", () => {
  assert.match(cardOf("Data Engineer").body.text, /⏱ Part-time/);
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
await ok("/jobs: the board per person and where each application stands, in the Jobs topic", () => {
  const t = calls[0].body.text;
  console.log("   /jobs ->\n     " + t.split("\n").join("\n     "));
  assert.match(t, /Diba<\/b>: \d+ open · 2 applied · 1 waiting · 1 interviews/);
  assert.match(t, /<b>Applications<\/b>\n🗓 Interview · <b>[^<]+<\/b> - .+ \(Diba, \d\d\.\d\d\)/);
  assert.match(t, /🔁 Applied before · <b>Vattenfall GmbH<\/b>/);
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
  assert.equal(sent().filter((c) => /open the job/.test(c.body.text)).length, Math.min(open.length, 4));
  assert.equal(row(DB, analyst).status, "interview");
  assert.equal(await st.kvGet("jobs_repost"), "0");
  net.tg = []; await J.jobsStep(E, st, tg);
  assert.ok(!net.tg.some((c) => c.method === "deleteMessage"));
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
  assert.deepEqual(group.body.commands.map((x) => x.command), ["jobs", "cv", "jobreport", "skills", "finds"]);
  const mine = c.find((x) => x.body.scope.type === "chat_member");
  assert.equal(mine.body.scope.user_id, 1000001);
  assert.ok(mine.body.commands.some((x) => x.command === "review") && mine.body.commands.some((x) => x.command === "jobs"));
  net.tg = []; await tick();
  assert.ok(!net.tg.some((x) => x.method === "setMyCommands"));
});

console.log("\n5. only Diba searching (the default)");
{
  const [DB2, st2, E2] = await fresh();
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

console.log(`\nall ${pass} jobs checks passed`);
