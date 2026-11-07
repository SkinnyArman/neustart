// Offline tests for /setup (src/wizard.ts): a whole setup from a fresh bot,
// and that it can't harm a bot that's already set up - private chat and
// the owner only, an existing config kept unless restarted (and then saved
// for /setup undo), group chatter still ignored.
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

const net = { tg: [], ka: "ok" };
const TOWNS = { leipzig: { _0: "Deutschland", _4233: "Leipzig - Sachsen", _4278: "Leipzig, Zentrum - Leipzig" },
  neustadt: { _0: "Deutschland", _1: "Neustadt - Bremen", _2: "Neustadt - Sachsen", _3: "Neustadt - Hessen" } };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("api.telegram.org")) { net.tg.push({ method: url.split("/").pop(), body: JSON.parse(init.body) }); return Response.json({ ok: true, result: { message_id: 50 + net.tg.length } }); }
  if (url.includes("s-ort-empfehlungen.json")) {
    if (net.ka === "down") return new Response("", { status: 503 });
    const q = new URL(url).searchParams.get("query").toLowerCase();
    return Response.json(TOWNS[q] ?? { _0: "Deutschland" });
  }
  throw new Error("unexpected fetch " + url);
};
console.error = () => {};

const { normalize } = await import(SRC + "config.ts");
const worker = (await import(SRC + "index.ts")).default;
let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ✓", name); };
const OWNER = 1000001, FRIEND = 2000002, GROUP = -100;

function bot(config) {
  const DB = makeDB();
  if (config) DB.raw.prepare("INSERT INTO kv (k,v) VALUES ('config', ?)").run(JSON.stringify(config));
  const E = { DB, OPENAI_API_KEY: "k", TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: String(GROUP), TELEGRAM_OWNER_ID: String(OWNER), WEBHOOK_SECRET: "s" };
  const post = async (update) => { net.tg = []; await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" }, body: JSON.stringify(update) }), E); return net.tg; };
  const say = (text, { from = OWNER, chat = OWNER, type = "private" } = {}) => post({ message: { text, from: { id: from }, chat: { id: chat, type }, message_id: 1 } });
  const tap = (data, { from = OWNER, chat = OWNER } = {}) => post({ callback_query: { id: "q", data: "su:" + data, from: { id: from }, message: { chat: { id: chat, type: "private" }, message_id: 9 } } });
  const kv = (k) => DB.raw.prepare("SELECT v FROM kv WHERE k=?").get(k)?.v ?? null;
  return { DB, E, say, tap, kv };
}
const last = (calls) => calls.filter((c) => c.method === "sendMessage").at(-1)?.body;
const buttons = (calls) => (last(calls)?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);

console.log("\n1. a whole setup, from a fresh bot");
{
  const b = bot(null);
  let c = await b.say("/start");
  await ok("before anything: the bot says how to set it up, /setup among the ways", () => assert.match(last(c).text, /send \/setup to the bot in a private chat/));
  c = await b.say("/setup");
  await ok("/setup asks for the city first", () => assert.match(last(c).text, /Which city are you moving to/));
  c = await b.say("Leipzig");
  await ok("the city: Kleinanzeigen's code found by itself; then which modules (rooms, finds, jobs, Minijobs on; events off)", () => {
    assert.match(last(c).text, /What should the bot look for/);
    assert.deepEqual(buttons(c), ["su:t:rooms", "su:t:finds", "su:t:jobs", "su:t:casual_jobs", "su:t:events", "su:done"]);
    assert.match(last(c).reply_markup.inline_keyboard[4][0].text, /^⬜ /);
  });
  c = await b.tap("t:events");
  await ok("tapping switches one on, in place", () => {
    const e = c.find((x) => x.method === "editMessageReplyMarkup");
    assert.match(e.body.reply_markup.inline_keyboard[4][0].text, /^✅ 🎭 Events/);
  });
  c = await b.tap("done");
  c = await b.say("Sam");
  c = await b.say("twenty");
  await ok("a bad answer: said why, asked again", () => assert.match(last(c).text, /A number, please/));
  c = await b.say("24");
  c = await b.tap("p:she/her");
  c = await b.say("I'll study at Leipzig University\nnon-smoker\nGerman B2");
  c = await b.say("450");
  c = await b.say("https://example.com/x");
  await ok("a link that isn't WG-Gesucht: refused, with Skip offered", () => { assert.match(last(c).text, /isn't a WG-Gesucht search address/); });
  c = await b.say("https://www.wg-gesucht.de/wg-zimmer-in-Leipzig.77.0.1.0.html");
  await ok("then the finds: which items, the radius", () => assert.match(last(c).text, /Which cheap or free things/));
  c = await b.tap("t:washer"); c = await b.tap("t:bike"); c = await b.tap("done");
  c = await b.tap("km:20");
  c = await b.say("Sam");
  c = await b.say("Werkstudent UX, UX Designer\nProduct Designer");
  c = await b.tap("done");
  await ok("a CV is needed before Done", () => assert.ok(c.some((x) => x.method === "answerCallbackQuery" && /Paste the CV first/.test(x.body.text))));
  c = await b.say("Sam Example - M.A. Interaction Design, Leipzig. Two years as a UX designer: user research, Figma prototypes, usability tests.");
  await ok("the CV in parts: 'more, or Done'", () => assert.match(last(c).text, /more, or tap Done/));
  c = await b.say("Skills: Figma, user research, HTML/CSS. German B2.");
  c = await b.tap("done");
  c = await b.tap("more");
  await ok("➕ Add someone: the next person's name", () => assert.match(last(c).text, /Next person/));
  c = await b.say("Robin"); c = await b.say("Data Analyst"); c = await b.say("Robin Example - B.Sc. Statistics, SQL and Python, two internships in analytics."); c = await b.tap("done");
  c = await b.tap("done");
  c = await b.tap("yes");
  c = await b.tap("same");
  c = await b.tap("done");
  c = await b.tap("only");
  await ok("events outside Cottbus: says only career events can be found", () => assert.match(last(c).text, /only know Cottbus so far; for Leipzig only career events/));
  c = await b.tap("done");
  c = await b.tap("b:20");
  await ok("the summary, before anything is saved", () => {
    const t = last(c).text;
    assert.match(t, /City: Leipzig/); assert.match(t, /Rooms: up to 450 €, 2 searches/);
    assert.match(t, /Finds within 20 km: 🛏 Bed, 🗄 Kommode, 🧶 Rug, 🧼 Washing machine, 🎁 Free stuff/);
    assert.match(t, /Jobs for Sam, Robin in Leipzig \(student permit\)/); assert.match(t, /Minijobs: Leipzig only/); assert.match(t, /Events: career/);
    assert.equal(b.kv("config"), null);
  });
  c = await b.tap("save");
  const cfg = normalize(JSON.parse(b.kv("config")));
  await ok("💾 Save: a config the bot can run on, exactly as answered", () => {
    assert.match(last(c).text, /Saved/);
    assert.deepEqual(cfg.problems, []);
    assert.equal(cfg.city, "Leipzig"); assert.deepEqual(cfg.ka, { slug: "leipzig", id: "4233" });
    assert.deepEqual(cfg.modules, { rooms: true, finds: true, jobs: true, casual_jobs: true, events: true });
    assert.equal(cfg.rooms.about.pronouns, "she/her"); assert.equal(cfg.rooms.filters.skip_female_only, false);
    assert.deepEqual(cfg.rooms.searches.map((x) => x.url), ["https://www.kleinanzeigen.de/s-auf-zeit-wg/leipzig/anzeige:angebote/c199l4233", "https://www.wg-gesucht.de/wg-zimmer-in-Leipzig.77.0.1.0.html"]);
    assert.equal(cfg.finds.radius_km, 20); assert.equal(cfg.finds.items.washer.on, true); assert.equal(cfg.finds.items.bike.on, false);
    assert.deepEqual(cfg.jobs.people.map((p) => [p.name, p.searches]), [["Sam", ["Werkstudent UX", "UX Designer", "Product Designer"]], ["Robin", ["Data Analyst"]]]);
    assert.match(cfg.jobs.people[0].cv, /Figma prototypes[\s\S]*HTML\/CSS/);
    assert.equal(cfg.jobs.student_permit, true); assert.deepEqual(cfg.jobs.cities, [{ name: "Leipzig", radius_km: 50 }]);
    assert.equal(cfg.casual_jobs.only_city, true);
    assert.equal(cfg.events.culture, false); assert.equal(cfg.events.career, true); assert.equal(cfg.events.max_price, 20);
    assert.equal(b.kv("setup"), "");
  });
  c = await b.say("hello?");
  await ok("after saving, plain messages are ignored again", () => assert.equal(c.length, 0));
  c = await b.say("/status", { chat: GROUP, type: "supergroup" });
  await ok("and the bot runs on it: /status works", () => assert.ok(!/no config yet/.test(last(c).text)));
}

console.log("\n2. it can't harm a bot that's set up");
{
  const b = bot(CONFIG);
  const before = b.kv("config");
  let c = await b.say("/setup");
  await ok("/setup with a config already there: only says so, changes nothing", () => {
    assert.match(last(c).text, /already set up for Cottbus[\s\S]*\/setup restart[\s\S]*\/setup undo/);
    assert.equal(b.kv("config"), before); assert.equal(b.kv("setup"), null);
  });
  c = await b.say("Leipzig");
  await ok("…and a plain message afterwards is ignored", () => assert.equal(c.length, 0));
  c = await b.say("/setup", { from: FRIEND, chat: FRIEND });
  await ok("someone else: refused like any owner command", () => assert.match(last(c).text, /only answers to them/));
  c = await b.say("/setup", { chat: GROUP, type: "supergroup" });
  await ok("in the group: asked to do it in private", () => assert.match(last(c).text, /in private: open a chat with me/));
  c = await b.say("/setup restart");
  await ok("/setup restart: starts over, the bot keeps running on the old config meanwhile", () => {
    assert.match(last(c).text, /Which city/); assert.equal(b.kv("config"), before);
  });
  c = await b.say("some chatter", { from: FRIEND, chat: GROUP, type: "supergroup" });
  await ok("group chatter during a setup: still ignored", () => assert.equal(c.length, 0));
  c = await b.say("Leipzig", { from: FRIEND, chat: FRIEND });
  await ok("someone else's plain message during a setup: ignored", () => assert.equal(c.length, 0));
  c = await b.say("/setup cancel");
  await ok("/setup cancel: answers dropped, config untouched", () => { assert.match(last(c).text, /Nothing was changed/); assert.equal(b.kv("config"), before); });
  // restart, run it through quickly with jobs only, save, then undo
  await b.say("/setup restart"); await b.say("Leipzig");
  for (const t of ["t:rooms", "t:finds", "t:casual_jobs", "done"]) await b.tap(t);
  await b.say("Kim"); await b.say("Data Analyst"); await b.say("Kim Example - statistics student with SQL and Python, an internship in reporting."); await b.tap("done");
  await b.tap("done"); await b.tap("no"); await b.tap("same");
  c = await b.tap("save");
  await ok("saving over a config keeps the old one for /setup undo", () => {
    assert.match(last(c).text, /\/setup undo brings back the setup from before/);
    assert.equal(normalize(JSON.parse(b.kv("config"))).city, "Leipzig");
    assert.equal(b.kv("config_backup"), before);
  });
  c = await b.say("/setup undo");
  await ok("/setup undo: the old config is back, exactly", () => { assert.match(last(c).text, /Back to the setup from before/); assert.equal(b.kv("config"), before); });
}

console.log("\n3. the city");
{
  const b = bot(null);
  await b.say("/setup");
  let c = await b.say("Neustadt");
  await ok("more than one town of that name: which one, as buttons", () => {
    assert.match(last(c).text, /more than one Neustadt/);
    assert.deepEqual(buttons(c), ["su:town:0", "su:town:1", "su:town:2"]);
  });
  c = await b.tap("town:1");
  await ok("the chosen town's code", () => { assert.match(last(c).text, /What should the bot look for/); assert.equal(JSON.parse(b.kv("setup")).a.ka, "neustadt/l2"); });
  const b2 = bot(null); await b2.say("/setup");
  c = await b2.say("Xyzville");
  await ok("a town Kleinanzeigen doesn't know: asked to check the spelling", () => assert.match(last(c).text, /doesn't know a town called Xyzville/));
  net.ka = "down";
  const b3 = bot(null); await b3.say("/setup"); await b3.say("Leipzig");
  for (const t of ["t:rooms", "t:jobs", "t:casual_jobs", "done"]) await b3.tap(t);
  await b3.tap("done"); c = await b3.tap("km:30");
  c = await b3.tap("save");
  await ok("Kleinanzeigen unreachable: the summary says what's missing, and nothing broken is saved", () => {
    assert.ok(c.some((x) => /Can't save yet[\s\S]*kleinanzeigen/.test(x.body?.text ?? "")));
    assert.equal(b3.kv("config"), null);
  });
  net.ka = "ok";
}

console.log(`\nall ${pass} setup checks passed`);
