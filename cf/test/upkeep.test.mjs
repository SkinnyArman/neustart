// Offline tests for keeping the bot honest: the watchdog that tells the
// group once when a search stops working (and once when it's back), and
// the re-checks that mark cards whose ad is gone. Fake clock, fake network.
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

let NOW = Date.UTC(2026, 10, 10, 8, 0);
const D = Date;
globalThis.Date = class extends D { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, 0, ...a);
console.error = () => {};
const net = { tg: [], gone: new Set(), ka: "ok", baStatus: 200 };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("api.telegram.org")) { net.tg.push({ method: url.split("/").pop(), body: JSON.parse(init.body) }); return Response.json({ ok: true, result: { message_id: 777 } }); }
  if (url.includes("/jobdetails/")) {
    const ref = new TextDecoder().decode(Uint8Array.from(atob(url.split("/").pop()), (c) => c.charCodeAt(0)));
    return net.gone.has(ref) ? new Response("gone", { status: 404 }) : Response.json({ stellenangebotsBeschreibung: "x" });
  }
  if (url.includes("kleinanzeigen.de/s-anzeige/")) {
    if (net.ka === "block") return new Response("Access denied", { status: 403 });
    const id = url.split("/").pop();
    return new Response(net.gone.has(id) ? `<html>${'<article class="aditem" data-adid="1"></article>'}${" ".repeat(3000)}</html>`
      : `<html><p id="viewad-description-text">Noch da, gut erhalten.</p></html>`);
  }
  if (url.includes("arbeitnow.example")) return new Response("", { status: net.gone.has(url) ? 404 : 200 });
  if (url.includes("api.openai.com")) return new Response('{"choices":[{"message":{"content":"OK"}}]}');
  throw new Error("unexpected fetch " + url);
};

const { Store } = await import(SRC + "store.ts");
const { Telegram } = await import(SRC + "telegram.ts");
const { normalize } = await import(SRC + "config.ts");
const W = await import(SRC + "watch.ts");
const worker = (await import(SRC + "index.ts")).default;
let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ✓", name); };
const tg = new Telegram("T", "-100");
const sends = () => net.tg.filter((c) => c.method === "sendMessage").map((c) => c.body.text);
const hours = (h) => { NOW += h * 3600_000; };

// ---------------------------------------------------------------- the watchdog
console.log("\n1. the watchdog");
{
  const DB = makeDB(); const st = new Store(DB);
  const cfg = normalize({ ...CONFIG, casual_jobs: { sources: ["minijobs", "kleinanzeigen"] } });
  await W.watchdog(cfg, st, tg);                                   // first look: every source's clock starts
  const all = ["rooms_wg", "rooms_ka", "finds", "jobs_ba", "jobs_arbeitnow", "casual_ba", "casual_ka"];
  await ok("first look: a clock for each source this config uses", async () => {
    for (const s of all) assert.ok(await st.kvGet("health:" + s), s);
  });
  // everything works for a while, except the Jobbörse for jobs
  const healthy = async () => { for (const s of all.filter((x) => x !== "jobs_ba")) await W.noteOk(st, s, 5); };
  for (let i = 0; i < 13; i++) { hours(1); await healthy(); if (i === 2) await W.noteError(st, "jobs_ba", new Error("Jobbörse 503")); }
  net.tg = [];
  await W.watchdog(cfg, st, tg);
  await ok("12 hours without the Jobbörse working: suspected at one check - nothing sent yet", async () => {
    assert.deepEqual(sends(), []);
    assert.equal(await st.kvGet("alert:jobs_ba"), "suspect");
  });
  await W.watchdog(cfg, st, tg);
  await ok("…a second check within the hour does nothing (hourly)", () => assert.deepEqual(sends(), []));
  hours(1); await healthy(); await W.watchdog(cfg, st, tg);
  await ok("still broken an hour later: ONE message, with the last error", () => {
    assert.equal(sends().length, 1);
    assert.match(sends()[0], /^⚠️ <b>Jobbörse \(jobs\) hasn't worked for 14 hours \(last error: Jobbörse 503\)<\/b>/);
    assert.match(sends()[0], /You'll hear once more when it works again/);
  });
  for (let i = 0; i < 24; i++) { hours(1); await healthy(); await W.watchdog(cfg, st, tg); }
  await ok("a day more of it: no more messages", () => assert.equal(sends().length, 1));
  await ok("/status and /health list it meanwhile", async () => {
    assert.match((await W.problems(cfg, st)).join("\n"), /Jobbörse \(jobs\) hasn't worked for \d+ hours/);
  });
  hours(1); await W.noteOk(st, "jobs_ba", 3); await healthy(); await W.watchdog(cfg, st, tg);
  await ok("works again: one 'works again', and the problem is cleared", async () => {
    assert.equal(sends().length, 2); assert.equal(sends()[1], "✅ <b>Jobbörse (jobs) works again.</b>");
    assert.deepEqual(await W.problems(cfg, st), []);
  });
  // a layout change: pages come back fine, but empty
  net.tg = [];
  const others = async () => { for (const s of all.filter((x) => x !== "finds" && x !== "jobs_ba")) await W.noteOk(st, s, 5); };
  for (let i = 0; i < 8; i++) { hours(0.2); await W.noteOk(st, "finds", 0); }
  hours(1); await others(); await W.noteOk(st, "finds", 0); await W.noteOk(st, "jobs_ba", 0);
  await W.watchdog(cfg, st, tg); hours(1); await others(); await W.noteOk(st, "finds", 0); await W.noteOk(st, "jobs_ba", 0); await W.watchdog(cfg, st, tg);
  await ok("empty pages again and again (a changed layout): one message; empty Jobbörse searches are normal", () => {
    assert.equal(sends().length, 1);
    assert.match(sends()[0], /^⚠️ <b>Kleinanzeigen \(finds\) keeps reading empty pages \(\d+ in a row\) - the site may have changed its layout/);
  });
  await W.noteOk(st, "finds", 12); hours(1); await W.watchdog(cfg, st, tg);
  await ok("one page with ads again: back to normal", () => assert.match(sends().at(-1), /Kleinanzeigen \(finds\) works again/));
}
{
  const DB = makeDB(); const st = new Store(DB);
  const cfg = normalize(CONFIG);
  await W.watchdog(cfg, st, tg);
  await st.kvSet("blocked_until_ka", String(Math.floor(NOW / 1000) + 40 * 3600));       // Kleinanzeigen limiting, with its own notice
  await st.kvSet("paused_until", "-1");                                                 // the room search paused
  net.tg = [];
  for (let i = 0; i < 30; i++) { hours(1); await W.noteOk(st, "jobs_ba", 2); await W.noteOk(st, "jobs_arbeitnow", 2); await W.noteOk(st, "casual_ba", 2); await W.watchdog(cfg, st, tg); }
  await ok("a site backing off with its own notice, or a paused search: no watchdog message", () => assert.deepEqual(sends(), []));
}

console.log("\n2. /health?ai");
{
  const DB = makeDB(); const st = new Store(DB); await st.kvSet("config", JSON.stringify(CONFIG));
  const E = { DB, OPENAI_API_KEY: "k", FINDS_MODEL: "gpt-5.6-luna", TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "-100", WEBHOOK_SECRET: "s" };
  const seen = [];
  const f0 = globalThis.fetch;
  globalThis.fetch = (u, i) => { if (String(u).includes("openai.com")) seen.push({ u: String(u), body: JSON.parse(i.body) }); return f0(u, i); };
  const r = await (await worker.fetch(new Request("https://w/health?ai"), E)).json();
  globalThis.fetch = f0;
  await ok("a real tiny request (not a model lookup), and the problems list", () => {
    assert.equal(seen[0].u, "https://api.openai.com/v1/chat/completions");
    assert.equal(seen[0].body.model, "gpt-5.6-luna"); assert.equal(seen[0].body.max_completion_tokens, 16);
    assert.deepEqual(r, { ok: true, openai: "ok", problems: [] });
  });
}

// ---------------------------------------------------------------- stale cards
console.log("\n3. cards whose ad is gone");
const E = (DB) => ({ DB, OPENAI_API_KEY: "k", TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "-100", WEBHOOK_SECRET: "s" });
const secs = () => Math.floor(NOW / 1000);
{
  const J = await import(SRC + "jobs.ts");
  const DB = makeDB(); const st = new Store(DB); await st.kvSet("config", JSON.stringify(CONFIG));
  for (const k of ["rooms", "jobs", "casual_jobs"]) await st.kvSet("intro:" + k, "1");
  await st.kvSet("jobs_query", "0"); await st.kvSet("jobs_arbeitnow_at", String(secs()));
  await J.jobsBoard(DB, st);                                      // creates the table
  const add = (id, status, postedDaysAgo, url = "u") => DB.raw.prepare(
    `INSERT INTO jobs (id,dkey,source,title,company,place,url,remote,kind,status,person,facts,first_seen,posted_at,msg_id)
     VALUES (?,?,?,?,?,?,?,0,'',?,?,?,?,?,?)`).run(id, id, "Jobbörse", "Werkstudent " + id, "Firma", "Berlin", url, status, "diba",
       JSON.stringify({ kind: "werkstudent", why: "fits" }), secs() - 9 * 86400, secs() - postedDaysAgo * 86400, 500 + id.length);
  add("ba:1", "posted", 4); add("ba:2", "posted", 4); add("ba:3", "posted", 1); add("ba:4", "applied", 4);
  add("an:x", "posted", 5, "https://arbeitnow.example/x"); add("li:9", "posted", 6);
  net.gone = new Set(["1", "4", "https://arbeitnow.example/x"]);
  const f0 = globalThis.fetch; const asked = [];
  globalThis.fetch = (u, i) => { if (/arbeitsagentur|arbeitnow|linkedin/.test(String(u))) asked.push(String(u)); return /seeMoreJobPostings|pc\/v6\/jobs|job-board-api/.test(String(u)) ? Response.json({ ergebnisliste: [], data: [] }) : f0(u, i); };
  net.tg = [];
  await J.jobsStep(E(DB), st, tg); await J.jobsStep(E(DB), st, tg);
  globalThis.fetch = f0;
  const row = (id) => DB.raw.prepare("SELECT status, checked_at FROM jobs WHERE id=?").get(id);
  await ok("jobs: posted 3+ days ago and taken down → 'No longer listed', and its card deleted", () => {
    assert.equal(row("ba:1").status, "expired");
    assert.ok(net.tg.some((c) => c.method === "deleteMessage" && c.body.message_id === 500 + "ba:1".length));
    assert.equal(row("an:x").status, "expired");
  });
  await ok("…still listed: only noted as checked; too new, applied to, or LinkedIn: not looked up", () => {
    assert.equal(row("ba:2").status, "posted"); assert.ok(row("ba:2").checked_at);
    assert.equal(row("ba:3").checked_at, null); assert.equal(row("ba:4").status, "applied"); assert.equal(row("li:9").checked_at, null);
    assert.ok(!asked.some((u) => /linkedin/.test(u)));
  });
  await ok("/jobs counts only what's open", async () => assert.match((await J.jobsBoard(DB, st))[0], /Diba<\/b>\n<pre>🆕 New {17}3\n/));
}
{
  const C = await import(SRC + "casual.ts");
  const DB = makeDB(); const st = new Store(DB); await st.kvSet("config", JSON.stringify(CONFIG)); await st.kvSet("intro:casual_jobs", "1");
  await st.kvSet("casual_searched_at", String(secs()));
  await C.casualLine(st, DB);                                     // creates the table
  const add = (id, daysAgo) => DB.raw.prepare(`INSERT INTO casual (id,dkey,title,company,place,status,first_seen,posted_at,msg_id) VALUES (?,?,?,?,?,'posted',?,?,?)`)
    .run(id, id, "Aushilfe " + id.slice(-3), "Laden", "Cottbus", secs() - 9 * 86400, secs() - daysAgo * 86400, 600);
  add("ba:20001", 4); add("kj:/s-anzeige/x/701-107-7743", 4); add("ba:20002", 1);
  net.gone = new Set(["20001", "701-107-7743"]);
  net.tg = [];
  const w = []; await worker.scheduled({ cron: C.CASUAL_CRON, scheduledTime: NOW }, E(DB), { waitUntil: (p) => w.push(p) }); await Promise.all(w);
  const row = (id) => DB.raw.prepare("SELECT status FROM casual WHERE id=?").get(id).status;
  await ok("casual jobs: gone from the Jobbörse or Kleinanzeigen → the card says so; a new one isn't looked up", () => {
    assert.equal(row("ba:20001"), "gone"); assert.equal(row("kj:/s-anzeige/x/701-107-7743"), "gone"); assert.equal(row("ba:20002"), "posted");
    const e = net.tg.filter((c) => c.method === "editMessageText");
    assert.equal(e.length, 2); assert.match(e[0].body.text, /^🚫 <b>No longer listed<\/b>\n<s>Aushilfe /);
  });
}
{
  const B = await import(SRC + "finds.ts");
  const DB = makeDB(); const st = new Store(DB);
  await st.kvSet("config", JSON.stringify({ ...CONFIG, topics: "none" }));
  for (const k of ["bike", "bed", "kommode", "carpet", "free"]) { await st.kvSet("intro:" + k, "1"); await st.kvSet("bikes_checked:" + (k === "bike" ? "damen" : k), String(secs())); }
  for (const k of ["herren", "weiteres"]) await st.kvSet("bikes_checked:" + k, String(secs()));
  await B.findsStatus(DB, st);                                    // creates the table
  const add = (id, daysAgo, msg) => DB.raw.prepare(`INSERT INTO bikes (ad_id,url,title,price,status,first_seen,sent_at,item,msg_id) VALUES (?,?,?,?, 'sent',?,?,'bike',?)`)
    .run(id, `https://www.kleinanzeigen.de/s-anzeige/x/${id}`, "Damenrad " + id, "20 €", secs() - 9 * 86400, secs() - daysAgo * 86400, msg);
  add("ka-1", 4, 801); add("ka-2", 5, null);
  net.gone = new Set(["ka-1", "ka-2"]); net.tg = [];
  await B.findsStep(E(DB), st, tg); await B.findsStep(E(DB), st, tg);
  const row = (id) => DB.raw.prepare("SELECT status FROM bikes WHERE ad_id=?").get(id).status;
  await ok("finds: a deleted ad → 'gone', the photo's caption edited (one per tick); one without a stored card just changes status", () => {
    assert.equal(row("ka-1"), "gone"); assert.equal(row("ka-2"), "gone");
    const e = net.tg.find((c) => c.method === "editMessageCaption");
    assert.equal(e.body.message_id, 801); assert.match(e.body.caption, /^🚫 <b>Gone from Kleinanzeigen<\/b>\n<s>Damenrad ka-1<\/s>/);
  });
  await ok("/finds counts them as posted, and says how many are gone", async () => assert.match(await B.findsStatus(DB, st), /Posted total: 2 \(2 gone since\)/));
}

console.log("\n4. a new ad is new for 3 days");
{
  const B = await import(SRC + "finds.ts");
  const DB = makeDB(); const st = new Store(DB);
  await st.kvSet("config", JSON.stringify({ ...CONFIG, topics: "none" }));
  const d = (daysAgo) => { const x = new Date(NOW - daysAgo * 86400_000); return `${String(x.getUTCDate()).padStart(2, "0")}.${String(x.getUTCMonth() + 1).padStart(2, "0")}.${x.getUTCFullYear()}`; };
  const card = (id, title, date) => `<article class="aditem" data-adid="${id}" data-href="/s-anzeige/x-${id}/${id}-217-7743"><div><svg></svg><span>03046 Cottbus</span><span class="k">(2 km)</span></div><div><svg></svg><span>${date}</span></div><h3><a class="t" href="/s-anzeige/x-${id}/${id}-217-7743">${title}</a></h3><p class="text-title3 font-bold">20 €</p></article>`;
  const page = `<html>${card(31, "Damenrad 28 Zoll", d(2))}${card(32, "Herrenrad 28 Zoll", d(4))}${" ".repeat(3000)}</html>`;
  const f0 = globalThis.fetch;
  globalThis.fetch = (u, i) => (String(u).includes("art_s:damen") ? Promise.resolve(new Response(page)) : f0(u, i));
  await B.findsStep(E(DB), st, tg, true);
  globalThis.fetch = f0;
  const why = (id) => DB.raw.prepare("SELECT why FROM bikes WHERE ad_id=?").get(id)?.why;
  await ok("an ad dated 2 days ago is still new (it was 2 days at most before); 4 days ago is the backlog", () => {
    assert.ok(!/old ad/.test(why("ka-31") ?? ""), why("ka-31"));
    assert.match(why("ka-32"), /^old ad/);
  });
}

console.log(`\nall ${pass} upkeep checks passed`);
