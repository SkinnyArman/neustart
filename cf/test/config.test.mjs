// Offline tests for the config: reading and checking it, and a bot set up
// for somewhere else entirely - another city, other people, other sizes,
// modules switched off, topics it creates itself. test/golden.mjs covers the
// opposite: that the original setup still behaves exactly as before.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { CONFIG } from "./fixtures/config.mjs";

const SRC = new URL("../src/", import.meta.url).pathname;
const TOML_BEFORE = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8").replace(/-- bike alerts[\s\S]*$/, "");
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a.map((x) => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x)); return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
}
const makeDB = () => { const db = new DatabaseSync(":memory:"); db.exec(SCHEMA); return { prepare: (s) => new Stmt(db, s), raw: db }; };

// ---------------------------------------------------------------- network
const net = { calls: [], topics: "ok", nextTopic: 7000, msg: 100 };
const kaCard = (id, title, price, place, km) =>
  `<article class="aditem" data-adid="${id}" data-href="/s-anzeige/x-${id}/${id}-1-4233">` +
  `<div><svg></svg><span>${place}</span><span class="k">(${km} km)</span></div><div><svg></svg><span>Heute, 10:00</span></div>` +
  `<h3><a class="t" href="/s-anzeige/x-${id}/${id}-1-4233">${title}</a></h3><p class="mb-xsmall">gut</p><p class="text-title3 font-bold">${price}</p></article>`;
const kaPage = (cards) => `<html>${cards.join("")}${" ".repeat(3000)}</html>`;
const KA = {
  betten: kaPage([kaCard(1, "Bett 160x200 Eiche", "80 €", "04109 Leipzig", 2), kaCard(2, "IKEA Malm Bett 140x200", "50 €", "04109 Leipzig", 1)]),
  damen: kaPage([kaCard(3, "Damenrad 28 Zoll", "20 €", "04109 Leipzig", 3)]),
};
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  net.calls.push({ url, body });
  if (url.includes("kleinanzeigen.de")) {
    if (url.includes("/s-anzeige/")) return new Response(`<html><p id="viewad-description-text">Massivholz, sehr guter Zustand, Abholung.</p></html>`);
    const art = /art_s:(\w+)/.exec(url)?.[1];
    return new Response(KA[art] ?? kaPage([kaCard(9, "Etwas", "5 €", "04109 Leipzig", 1)]));
  }
  if (url.includes("wg-gesucht.de")) return new Response("<html></html>");
  if (url.includes("arbeitsagentur.de")) {
    if (url.includes("/jobdetails/")) return Response.json({ stellenangebotsBeschreibung: "Kasse, Beratung. 15 € pro Stunde." });
    const q = new URL(url).searchParams;
    const ad = (ref, title, vollzeit = false) => ({ referenznummer: ref, stellenangebotsTitel: title, firma: "Firma", stellenangebotsart: "ARBEIT",
      arbeitszeitVollzeit: vollzeit, stellenlokationen: [{ adresse: { ort: "Leipzig" } }] });
    return Response.json({ ergebnisliste: q.get("arbeitszeit") === "mj" ? [ad("30001", "Aushilfe im Café (m/w/d)")]
      : [ad("40001", "UX Designer (m/w/d)", true), ad("40002", "Senior UX Designer", false), ad("40003", "Sachbearbeiter Lager", false)] });
  }
  if (url.includes("arbeitnow.com"))
    return Response.json({ data: [{ slug: "remote-ux", company_name: "R", title: "UX Designer remote", description: "", remote: true, url: "u", location: "Remote", job_types: [] },
      { slug: "leipzig-ux", company_name: "L", title: "Product Designer (UX)", description: "<p>Figma</p>", remote: false, url: "u2", location: "Leipzig", job_types: [] }] });
  if (url.includes("api.openai.com")) {
    const sys = body.messages[0].content;
    const out = /match German job ads/.test(sys) ? { for: /Product/.test(body.messages[1].content) ? "sam" : "sam", kind: "other", why: "UX work", gaps: [], german: "B2", hours: "", start: "", deadline: "", lang: "de", skills: ["Figma"] }
      : /You rate second-hand/.test(sys) ? { is_match: true, kind: "Bed", score: 7, why: "ok", notes: ["2 km from Leipzig", "Solid"] }
      : { language: "de", ad_summary: "", facts_used: [], thin_ad: false, message: "Hallo!" };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
  }
  if (url.includes("api.telegram.org")) {
    const method = url.split("/").pop();
    if (method === "createForumTopic") {
      if (net.topics === "fail") return new Response('{"ok":false,"description":"Bad Request: not enough rights to create a topic"}', { status: 400 });
      return Response.json({ ok: true, result: { message_thread_id: ++net.nextTopic, name: body.name } });
    }
    return Response.json({ ok: true, result: { message_id: ++net.msg } });
  }
  throw new Error("unexpected fetch " + url);
};
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, 0, ...a);
console.log = ((log) => (...a) => { if (!/^step:/.test(String(a[0]))) log(...a); })(console.log);
console.error = () => {};

const { normalize, parseKa, slugify } = await import(SRC + "config.ts");
const { Store } = await import(SRC + "store.ts");
const { Telegram } = await import(SRC + "telegram.ts");
const { systemPrompt } = await import(SRC + "prompt.ts");
const J = await import(SRC + "jobs.ts");
const worker = (await import(SRC + "index.ts")).default;

let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ✓", name); };
const tg = new Telegram("T", "-100");
const ENV = (DB) => ({ DB, OPENAI_API_KEY: "k", OPENAI_MODEL: "m", FINDS_MODEL: "gpt-5.6-luna",
  TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "-100", TELEGRAM_OWNER_ID: "1", WEBHOOK_SECRET: "s" });
const bot = async (config) => { const DB = makeDB(); const st = new Store(DB); if (config) await st.kvSet("config", JSON.stringify(config)); return [DB, st, ENV(DB)]; };
async function tick(E, minute) {
  const waits = [];
  await worker.scheduled({ cron: "", scheduledTime: Date.UTC(2026, 9, 27, 9, minute) }, E, { waitUntil: (p) => waits.push(p) });
  await Promise.allSettled(waits);
}
const send = (E, text, from = 1, extra = {}) => worker.fetch(new Request("https://w/", { method: "POST",
  headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" },
  body: JSON.stringify({ message: { text, from: { id: from }, chat: { id: -100 }, ...extra } }) }), E);
const tgCalls = (m) => net.calls.filter((c) => c.url.includes("api.telegram.org") && (!m || c.url.endsWith("/" + m)));
const texts = () => tgCalls().filter((c) => /send(Message|Photo)$/.test(c.url)).map((c) => c.body.text ?? c.body.caption);
const prompts = () => net.calls.filter((c) => c.url.includes("openai.com")).map((c) => c.body.messages);

// ---------------------------------------------------------------- 1. reading it
console.log("\n1. reading and checking the config");
await ok("Kleinanzeigen's place from a city URL, a category search, a short form or an object", () => {
  assert.deepEqual(parseKa("https://www.kleinanzeigen.de/s-cottbus/l7743"), { slug: "cottbus", id: "7743" });
  assert.deepEqual(parseKa("https://www.kleinanzeigen.de/s-auf-zeit-wg/cottbus/anzeige:angebote/c199l7743"), { slug: "cottbus", id: "7743" });
  assert.deepEqual(parseKa("https://www.kleinanzeigen.de/s-fahrraeder/leipzig/preis::30/c217l4233r20+fahrraeder.art_s:damen"), { slug: "leipzig", id: "4233" });
  assert.deepEqual(parseKa("https://www.kleinanzeigen.de/s-frankfurt-(main)/l4292?x=1"), { slug: "frankfurt-(main)", id: "4292" });
  assert.deepEqual(parseKa("cottbus/l7743"), { slug: "cottbus", id: "7743" });
  assert.deepEqual(parseKa({ slug: "berlin", id: 3331 }), { slug: "berlin", id: "3331" });
  for (const bad of ["", "https://www.kleinanzeigen.de/", "Cottbus", "https://www.kleinanzeigen.de/s-anzeige/bett/123-1-7743", null])
    assert.equal(parseKa(bad), null, String(bad));
});
await ok("a config without a city switches every module off, and says why", () => {
  const c = normalize({ modules: { rooms: true } });
  assert.deepEqual(Object.values(c.modules), [false, false, false, false]);
  assert.ok(c.problems.every((p) => /no city set/.test(p)) && c.problems.length === 4);
});
await ok("each module needs its own part: a room search, a Kleinanzeigen place, people", () => {
  const c = normalize({ city: "Leipzig", rooms: { about: { name: "Sam" }, searches: [] }, jobs: { people: [] } });
  assert.deepEqual(c.modules, { rooms: false, finds: false, jobs: false, casual_jobs: true });
  assert.equal(c.problems.length, 3);
  assert.match(c.problems.join("\n"), /rooms\.searches has no search[\s\S]*kleinanzeigen is missing[\s\S]*jobs\.people is empty/);
});
await ok("a module switched off on purpose is not a problem", () => {
  const c = normalize({ city: "Leipzig", modules: { rooms: false, finds: false, jobs: false } });
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.modules, { rooms: false, finds: false, jobs: false, casual_jobs: true });
});
await ok("defaults: prices, bed width, room size, radius, cities, topics created when needed", () => {
  const c = normalize({ city: "Leipzig", kleinanzeigen: "leipzig/l4233", modules: { rooms: false, jobs: false } });
  assert.equal(c.finds.radius_km, 30); assert.equal(c.casual_jobs.radius_km, 25);
  assert.deepEqual([c.finds.items.bike.max_price, c.finds.items.bed.max_price, c.finds.items.kommode.max_price, c.finds.items.carpet.max_price, c.finds.items.free.min_rating], [30, 100, 35, 30, 6]);
  assert.equal(c.finds.items.bed.width_cm, 140); assert.equal(c.finds.items.carpet.room_m2, 25);
  assert.match(c.finds.for_whom, /just moved to Leipzig/);
  assert.deepEqual(c.jobs.cities, [{ name: "Leipzig", radius_km: 50 }]);
  assert.equal(c.topics_mode, "auto"); assert.deepEqual(c.topics, {});
  assert.equal(normalize({ city: "X", topics: "none" }).topics_mode, "none");
});
await ok("people: id from the name, title words from the searches, unique ids, valid patterns", () => {
  const c = normalize({ city: "Leipzig", jobs: { people: [
    { name: "Zoë Müller", searches: ["Werkstudent UX Design", "Junior Product Designer (m/w/d)"], summary: "x" },
    { name: "Zoë Müller", searches: ["x"] },
    { name: "Kim", searches: ["QA"], title_words: ["test(er"] },
    { searches: ["y"] },
  ] } });
  const p = c.jobs.people[0];
  assert.equal(p.id, "zoe-muller"); assert.equal(p.full_name, "Zoë Müller"); assert.equal(p.active, true);
  assert.deepEqual(p.title_words, ["ux", "design", "product", "designer", "(m/w/d)"].filter((w) => w !== "(m/w/d)"));
  assert.match(c.problems.join("\n"), /two people are called zoe-muller[\s\S]*"test\(er" isn't a valid pattern[\s\S]*person 4 has no name/);
  assert.equal(slugify("Ärger Straße"), "arger-strasse");
});
await ok("student permit: the situation and the availability sentence are filled in", () => {
  const one = normalize({ city: "Leipzig", jobs: { student_permit: true, people: [{ name: "Sam", searches: ["UX"] }] } }).jobs;
  assert.match(one.situation, /^Sam is a student in Leipzig on a student residence permit/);
  assert.match(one.people[0].availability, /^student in Leipzig, as a Werkstudent up to 20 hours/);
  const two = normalize({ city: "Leipzig", jobs: { people: [{ name: "A", searches: ["x"] }, { name: "B", searches: ["y"], availability: "free from March" }] } }).jobs;
  assert.equal(two.situation, ""); assert.equal(two.people[0].availability, "based in Leipzig"); assert.equal(two.people[1].availability, "free from March");
});
await ok("the room prompt: city and pronouns filled in, nothing of Cottbus or 'he' left", () => {
  const she = systemPrompt("Leipzig", "she/her");
  assert.match(she, /INTRODUCE HERSELF FIRST/); assert.match(she, /who she is: name, age, moving to Leipzig/);
  assert.match(she, /once she has arrived, that she is in Leipzig/);
  const they = systemPrompt("Leipzig", "they/them");
  assert.match(they, /who they are:/); assert.match(they, /before\n  they arrive,/); assert.match(they, /once they have arrived, that they are in Leipzig/);
  for (const s of [she, they]) { assert.ok(!/\b(he|his|him|himself|He|His|HIMSELF)\b|Cottbus|\{\w+\}/.test(s)); }
});

// ---------------------------------------------------------------- 2. somewhere else
console.log("\n2. a bot for Leipzig: one person, not a student, a 160 bed");
const LEIPZIG = {
  city: "Leipzig",
  kleinanzeigen: "https://www.kleinanzeigen.de/s-leipzig/l4233",
  modules: { rooms: true, finds: true, jobs: true, casual_jobs: true },
  rooms: { about: { name: "Sam", pronouns: "she/her" }, style: {}, filters: {},
    searches: [{ name: "Leipzig", url: "https://www.wg-gesucht.de/wg-zimmer-in-Leipzig.77.0.1.0.html", hot: true }] },
  finds: { radius_km: 20, items: { bed: { width_cm: 160, max_price: 120 }, carpet: { room_m2: 18 }, kommode: { on: false } } },
  jobs: { remote: false, people: [{ name: "Sam", searches: ["UX Designer"], wants: "UX and product design", summary: "Designer", skills: ["Figma"], cv: "Sam CV" }] },
  casual_jobs: { radius_km: 10 },
};
{
  const [DB, st, E] = await bot(LEIPZIG);
  net.calls = [];
  for (let m = 0; m < 60; m++) { if (m % 10 === 5) await tick(E, m); }   // the finds trigger
  const urls = net.calls.map((c) => c.url).filter((u) => u.includes("kleinanzeigen.de") && !u.includes("/s-anzeige/"));
  await ok("finds search Leipzig (l4233) within 20 km; the bed search asks up to 120 €; the paused Kommode isn't searched", () => {
    assert.ok(urls.length >= 4, urls.join("\n"));
    assert.ok(urls.every((u) => /\/leipzig\/anzeige:angebote\//.test(u) && /l4233r20/.test(u)), urls.join("\n"));
    assert.ok(urls.some((u) => /preis::120\/c81l4233r20\+schlafzimmer\.art_s:betten/.test(u)));
    assert.ok(!urls.some((u) => /kommode/.test(u)));
  });
  await ok("a 160×200 bed passes, a 140×200 one is the wrong size", () => {
    assert.equal(DB.raw.prepare("SELECT why FROM bikes WHERE title='IKEA Malm Bett 140x200'").get().why, "size 140 wide");
    assert.notEqual(DB.raw.prepare("SELECT status FROM bikes WHERE title='Bett 160x200 Eiche'").get().status, "skipped");
  });
  await ok("the AI is told about Leipzig, a 160×200 bed and an 18 m² room - and the 'from Leipzig' note is dropped", () => {
    const sys = prompts().map((m) => m[0].content);
    const bed = sys.find((s) => /bed \(160×200\)/.test(s));
    assert.ok(bed); assert.match(bed, /around Leipzig, Germany/); assert.match(bed, /km from Leipzig centre/);
    assert.match(bed, /other sizes \(90, 100, 120, 140, 180 wide\)/);
    assert.ok(!sys.some((s) => /Cottbus|140×200/.test(s)));
    const card = texts().find((t) => /Bett 160x200/.test(t ?? ""));
    assert.ok(card && /• Solid/.test(card) && !/from Leipzig/.test(card), card);
  });
  await ok("each kind of find gets a topic of its own, created once", () => {
    const made = tgCalls("createForumTopic").map((c) => c.body.name);
    assert.deepEqual(made.sort(), [...new Set(made)].sort());
    assert.ok(made.includes("🛏 Bed"));
    const bedTopic = DB.raw.prepare("SELECT v FROM kv WHERE k='topic:bed'").get().v;
    assert.ok(tgCalls().filter((c) => /send(Message|Photo)$/.test(c.url) && /Bett 160/.test(c.body.caption ?? c.body.text ?? ""))
      .every((c) => String(c.body.message_thread_id) === bedTopic));
  });

  net.calls = [];
  for (let m = 0; m < 30; m++) { if (m % 10 === 3) await tick(E, m); }   // the jobs trigger
  await ok("jobs: Sam's search in Leipzig (50 km); no full-time filter without student_permit; no remote jobs", () => {
    const q = net.calls.filter((c) => c.url.includes("/pc/v6/jobs")).map((c) => new URL(c.url).searchParams);
    assert.ok(q.length && q.every((p) => p.get("was") === "UX Designer" && p.get("wo") === "Leipzig" && p.get("umkreis") === "50"));
    const row = (id) => DB.raw.prepare("SELECT status, why FROM jobs WHERE id=?").get(id);
    assert.equal(row("ba:40002").why, "senior or lead role");
    assert.equal(row("ba:40003").why, "not Sam's work");
    assert.notEqual(row("ba:40001").status, "skipped");                   // full-time, and that's fine here
    assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE id='an:remote-ux'").get().n, 0);
    assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE id='an:leipzig-ux'").get().n, 1);
  });
  await ok("the AI is told about one job seeker, with no student rules", () => {
    const m = prompts().find((x) => /match German job ads/.test(x[0].content));
    assert.match(m[0].content, /^You match German job ads to one job seeker\.\n\nSAM wants: UX and product design\n/);
    assert.match(m[0].content, /"for": "sam"\|"none",/);
    assert.ok(!/full-time|Werkstudent jobs, internships/.test(m[0].content.split("for: who should apply")[1]));
    assert.match(m[1].content, /^Searching right now: SAM only/);
  });
  await ok("the card is for Sam, in a Jobs topic of its own", () => {
    const c = tgCalls("sendMessage").find((x) => /^💼/.test(x.body.text));
    assert.match(c.body.text, /\n\n🧑‍💻 For Sam\n/);
    assert.equal(String(c.body.message_thread_id), DB.raw.prepare("SELECT v FROM kv WHERE k='topic:jobs'").get().v);
  });
  net.calls = [];
  await send(E, "/jobs");
  await ok("/jobs: the board names Leipzig only", () => assert.match(texts()[0], /^💼 <b>Jobs<\/b> \(Leipzig\)\n\n🧑‍💻 <b>Sam<\/b>/));
  net.calls = [];
  await send(E, "/jobreport");
  await ok("/jobreport counts per configured city", () => assert.match(texts()[0], /New matches this week: \d+ \(Leipzig \d+\)/));

  net.calls = [];
  await tick(E, 7);
  await ok("Minijobs in Leipzig within 10 km", () => {
    const q = new URL(net.calls.find((c) => c.url.includes("/pc/v6/jobs")).url).searchParams;
    assert.equal(q.get("wo"), "Leipzig"); assert.equal(q.get("umkreis"), "10"); assert.equal(q.get("arbeitszeit"), "mj");
  });
  net.calls = [];
  await tick(E, 0); await tick(E, 2);
  await ok("the room search uses Sam's own search", () =>
    assert.ok(net.calls.some((c) => c.url === "https://www.wg-gesucht.de/wg-zimmer-in-Leipzig.77.0.1.0.html")));
  net.calls = []; DB.raw.prepare("DELETE FROM kv WHERE k='commands_sent'").run();
  await tick(E, 13);
  await ok("the '/' menu: no Cottbus examples, /skills shows Sam's id", () => {
    const g = tgCalls("setMyCommands").find((c) => c.body.scope.type === "chat");
    assert.ok(g, "menu sent");
    assert.equal(g.body.commands.find((x) => x.command === "skills").description, "Skills list, e.g. /skills sam + Power BI");
  });
}

// ---------------------------------------------------------------- 3. three people
console.log("\n3. three people looking");
{
  const three = { ...CONFIG, jobs: { ...CONFIG.jobs, people: [...CONFIG.jobs.people.map((p) => ({ ...p, active: true })),
    { id: "kim", name: "Kim", searches: ["Data"], title_words: ["data"], summary: "Kim", cv: "Kim CV" }] } };
  const c = normalize(three);
  await ok("everyone is 'all', not 'both'", () => {
    const row = { id: "x", person: "all", status: "posted", title: "T", company: "C", place: "P", url: "u", source: "Jobbörse", facts: null };
    assert.match(J.card(row, c.jobs), /👥 For Diba & Arman & Kim/);
    assert.deepEqual(J.jobKeyboard(row, c.jobs)[0].map((b) => b.text), ["✍️ Cover letter (Diba)", "✍️ Cover letter (Arman)", "✍️ Cover letter (Kim)"]);
    assert.match(J.card({ ...row, person: "diba,kim" }, c.jobs), /For Diba & Kim/);
  });
  await ok("a title fits if it fits anyone; the reason names everyone's field", () => {
    assert.equal(J.jobRejectReason("Data Analyst", c.jobs), null);
    assert.equal(J.jobRejectReason("Koch (m/w/d)", c.jobs), "not data or frontend or Kim's work");
  });
}

// ---------------------------------------------------------------- 4. switched off, missing
console.log("\n4. modules switched off, no config at all");
{
  const [DB, st, E] = await bot({ ...LEIPZIG, modules: { rooms: false, finds: false, jobs: true, casual_jobs: false } });
  net.calls = [];
  for (const m of [0, 5, 7]) await tick(E, m);
  await ok("ticks of switched-off modules don't fetch anything", () =>
    assert.ok(!net.calls.some((c) => /kleinanzeigen|wg-gesucht|arbeitsagentur/.test(c.url)), net.calls.map((c) => c.url).join("\n")));
  net.calls = [];
  await send(E, "/review");
  await send(E, "/finds", 5);
  await send(E, "/help");
  await ok("their commands say so; /help lists only what's on", () => {
    const [review, finds, help] = texts();
    assert.match(review, /room search is switched off/);
    assert.match(finds, /Finds are switched off/);
    assert.ok(/\/jobs/.test(help) && !/\/finds|\/review/.test(help), help);
  });
  net.calls = [];
  await tick(E, 13);
  await ok("the '/' menu leaves them out", () => {
    const owner = tgCalls("setMyCommands").find((c) => c.body.scope.type === "chat_member").body.commands.map((x) => x.command);
    assert.deepEqual(owner, ["status", "start", "jobs", "cv", "jobreport", "skills", "help"]);
  });
  net.calls = [];
  await send(E, "/status");
  await ok("/status says the room search is off", () => assert.match(texts()[0], /^🏠 Room search: off\n\nJobs:/));
}
{
  const [DB, st, E] = await bot(null);
  net.calls = [];
  for (const m of [0, 3, 5, 7]) await tick(E, m);
  await send(E, "/status");
  await send(E, "/jobs", 5);
  await ok("no config yet: nothing is fetched, and the bot says what to do", () => {
    assert.ok(!net.calls.some((c) => !c.url.includes("api.telegram.org")));
    const [status, jobs] = texts();
    assert.match(status, /no config yet - fill in neustart\.yaml, then run: npm run config/);
    assert.match(jobs, /no config yet/);
  });
}

// ---------------------------------------------------------------- 5. topics
console.log("\n5. forum topics");
{
  const { topicOf } = await import(SRC + "topics.ts");
  const [DB, st] = await bot(null);
  let now = Date.UTC(2026, 9, 27, 9, 0);
  const D = Date; globalThis.Date = class extends D { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
  const cfg = normalize({ city: "X", topics: { jobs: 965 } });
  net.calls = []; net.topics = "fail";
  await ok("a fixed id is used as it is; no rights to create one: the main chat", async () => {
    assert.equal(await topicOf(cfg, st, tg, "jobs"), 965);
    assert.equal(await topicOf(cfg, st, tg, "rooms"), null);
    assert.equal(await topicOf(cfg, st, tg, "rooms"), null);
    assert.equal(tgCalls("createForumTopic").length, 1);                       // not tried on every post
  });
  net.topics = "ok"; now += 7 * 3600 * 1000;
  await ok("…tried again after six hours, then kept", async () => {
    const id = await topicOf(cfg, st, tg, "rooms");
    assert.ok(id > 7000);
    assert.equal(await topicOf(cfg, st, tg, "rooms"), id);
    assert.equal(tgCalls("createForumTopic").length, 2);
    assert.equal(tgCalls("createForumTopic")[1].body.name, "🏠 Rooms");
  });
  await ok("topics: none - everything in the main chat, nothing created", async () => {
    net.calls = [];
    assert.equal(await topicOf(normalize({ city: "X", topics: "none" }), st, tg, "free"), null);
    assert.equal(tgCalls("createForumTopic").length, 0);
  });
  globalThis.Date = D;
}

// ---------------------------------------------------------------- 6. the scripts
console.log("\n6. npm run config");
{
  const { readConfigFile, kvSql } = await import(new URL("../scripts/lib.mjs", import.meta.url).href);
  const dir = mkdtempSync(join(tmpdir(), "neustart-"));
  writeFileSync(join(dir, "sam.cv.txt"), "Sam's CV\nwith a 'quote'\n");
  writeFileSync(join(dir, "neustart.yaml"), `city: Leipzig\nmodules: { rooms: false, finds: false }\njobs:\n  people:\n    - name: Sam\n      searches: [UX]\n      cv_file: sam.cv.txt\n`);
  await ok("cv_file is read in from next to the config", () => {
    const raw = readConfigFile(join(dir, "neustart.yaml"));
    assert.equal(raw.jobs.people[0].cv, "Sam's CV\nwith a 'quote'");
    assert.equal(raw.jobs.people[0].cv_file, undefined);
  });
  await ok("quotes survive the trip into SQL", () => {
    const sql = kvSql("config", JSON.stringify({ cv: "Sam's" }));
    assert.equal(sql, `INSERT INTO kv (k,v) VALUES ('config','{"cv":"Sam''s"}') ON CONFLICT(k) DO UPDATE SET v=excluded.v;\n`);
    const db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"); db.exec(sql);
    assert.equal(JSON.parse(db.prepare("SELECT v FROM kv").get().v).cv, "Sam's");
  });
  const run = (file) => spawnSync(process.execPath, ["--no-warnings", new URL("../scripts/config.mjs", import.meta.url).pathname, file, "--check", "--offline"], { encoding: "utf8" });
  await ok("--check prints what the bot will do, and stores nothing", () => {
    const r = run(join(dir, "neustart.yaml"));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /City: +Leipzig\nModules: +jobs, casual_jobs\nJobs: +Sam - 1 searches/);
  });
  writeFileSync(join(dir, "bad.yaml"), `city: Leipzig\njobs:\n  people: []\n`);
  await ok("a config with problems is refused, with the reasons", () => {
    const r = run(join(dir, "bad.yaml"));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Fix these[\s\S]*rooms: rooms\.about\.name is missing[\s\S]*finds: kleinanzeigen is missing[\s\S]*jobs: jobs\.people is empty/);
  });
  await ok("the example config in the repo is valid as it is", () => {
    const r = run(new URL("../../neustart.example.yaml", import.meta.url).pathname);
    assert.equal(r.status, 0, r.stderr + r.stdout);
  });
}

console.log("\n7. npm run setup");
{
  const dir = mkdtempSync(join(tmpdir(), "neustart-setup-"));
  writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-x\nTELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_CHAT_ID=-100\nTELEGRAM_OWNER_ID=1\n");
  const setup = (cfg) => spawnSync(process.execPath, ["--no-warnings", new URL("../scripts/setup.mjs", import.meta.url).pathname,
    "--dry-run", "--config", cfg, "--env", join(dir, ".env")], { encoding: "utf8", input: "" });
  const r = setup(new URL("../../neustart.example.yaml", import.meta.url).pathname);
  await ok("a dry run walks every step in order and only prints the commands", () => {
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const steps = [...r.stdout.matchAll(/^(\d)\. /gm)].map((m) => m[1]).join("");
    assert.equal(steps, "1234567");
    assert.match(r.stdout, /\$ npx wrangler d1 create neustart[\s\S]*\$ npx wrangler deploy[\s\S]*\$ npx wrangler secret bulk [\s\S]*--file=config\.sql/);
    assert.match(r.stdout, /Saved to \.env: WEBHOOK_SECRET/);
  });
  await ok("…and changed nothing: no new .env line, no config.sql, wrangler.toml as it was", () => {
    assert.equal(readFileSync(join(dir, ".env"), "utf8").split("\n").length, 5);
    assert.equal(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"), TOML_BEFORE);
  });
  writeFileSync(join(dir, "bad.yaml"), "city: Leipzig\nmodules: { finds: false, jobs: false }\n");
  await ok("a config with problems stops setup before anything else", () => {
    const b = setup(join(dir, "bad.yaml"));
    assert.equal(b.status, 1); assert.match(b.stderr, /rooms\.about\.name is missing/); assert.ok(!/^2\. /m.test(b.stdout));
  });
}

console.log(`\nall ${pass} config checks passed`);
