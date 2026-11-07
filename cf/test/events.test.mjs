// Offline tests for src/events.ts: reading the real pages' markup (trimmed
// copies in fixtures/events), the budget, one card per show, the window,
// /events, and the trigger. Fake clock, fake network, in-memory D1.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { CONFIG } from "./fixtures/config.mjs";

const SRC = new URL("../src/", import.meta.url).pathname;
const FIX = (f) => readFileSync(new URL(`./fixtures/events/${f}`, import.meta.url), "utf8");
const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8").replace(/-- bike alerts[\s\S]*$/, "");
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a.map((x) => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x)); return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
}
const makeDB = () => { const db = new DatabaseSync(":memory:"); db.exec(SCHEMA); return { prepare: (s) => new Stmt(db, s), raw: db }; };

let NOW = Date.UTC(2026, 10, 7, 9, 1);          // Sat 7 Nov 2026, the day the fixtures were saved
const D = Date;
globalThis.Date = class extends D { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
console.log = ((log) => (...a) => { if (!/^step:/.test(String(a[0]))) log(...a); })(console.log);
console.error = () => {};
const DEVPOST = { hackathons: [
  { id: 1, title: "QNX Global Hackathon", url: "https://qnx.devpost.com/", submission_period_dates: "Nov 02 - Dec 15, 2026", displayed_location: { location: "Online" }, prize_amount: "$<span>10,000</span>", themes: [{ name: "IoT" }] },
  { id: 2, title: "Hack Ottawa", url: "https://x.devpost.com/", submission_period_dates: "Nov 15, 2026", displayed_location: { location: "Bayview Yards" } },
  { id: 3, title: "Berlin Data Jam", url: "https://y.devpost.com/", submission_period_dates: "Dec 19, 2026 - Jan 18, 2027", displayed_location: { location: "Berlin, Germany" } },
  { id: 4, title: "Old One", url: "https://z.devpost.com/", submission_period_dates: "Sep 01 - Oct 01, 2026", displayed_location: { location: "Online" } },
] };
const ICS = "BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nDTSTART:19700329T020000\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nDTSTART;TZID=Europe/Berlin:20261118T183000\r\nSUMMARY:PyData Berlin\\, November edition\r\nLOCATION:Somewhere\\, Berlin\r\nURL:https://www.meetup.com/pydata-berlin/events/1/\r\nUID:ev1@meetup.com\r\nDESCRIPTION:Talks on pandas and LLMs\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
const net = { tg: [], urls: [] };
globalThis.fetch = async (url, init = {}) => {
  url = String(url); net.urls.push(url);
  if (url.includes("api.telegram.org")) { net.tg.push({ method: url.split("/").pop(), body: JSON.parse(init.body) }); return Response.json({ ok: true, result: { message_id: 900 + net.tg.length } }); }
  if (url.includes("spielplan.html")) return new Response(FIX("theater.html"));
  // a show's own page: a logo, then the production photo (none for the film festival)
  if (url.includes("staatstheater-cottbus")) return new Response(/filmfestival/.test(url) ? "<p>no pictures</p>"
    : '<img src="/logo.png" width="360"><img src="/cache/img/4760_show.jpg" width="1440" height="960">');
  if (url.includes("bad-poster")) return new Response("nope", { status: 404 });
  if (url.includes("gladhouse")) return new Response(FIX("gladhouse.html"));
  if (url.includes("cottbus.de/veranstaltungen")) return new Response(FIX("cottbus.html"));
  if (url.includes("b-tu.de")) return new Response(FIX("btu.html"));
  if (url.includes("devpost.com")) return Response.json(DEVPOST);
  if (url.includes("meetup.com")) return new Response(ICS);
  throw new Error("unexpected fetch " + url);
};

const E = await import(SRC + "events.ts");
const { Store } = await import(SRC + "store.ts");
const { Telegram } = await import(SRC + "telegram.ts");
const worker = (await import(SRC + "index.ts")).default;
let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ✓", name); };
const tg = new Telegram("T", "-100");

console.log("\n1. reading the real pages");
await ok("Staatstheater: date, time, stage, category, title, ticket link; an open rehearsal is free", () => {
  const t = E.parseTheater(FIX("theater.html"));
  assert.ok(t.length >= 3, String(t.length));
  const n = t.find((e) => e.title === "Nabucco");
  if (n) { assert.equal(n.starts, "2026-11-08T19:00"); assert.match(n.place, /Großes Haus \(Staatstheater Cottbus\)/); assert.equal(n.tag, "Musiktheater"); assert.match(n.tickets, /eventim/); assert.equal(n.price, null); }
  assert.ok(t.every((e) => /^theater:/.test(e.id) && /^\d{4}-\d{2}-\d{2}/.test(e.starts) && e.url.startsWith("https://")));
});
await ok("Glad-House: date, time, title, the price from the text", () => {
  const g = E.parseGladhouse(FIX("gladhouse.html"));
  const after = g.find((e) => e.title === "EAST SIDE AFTER DARK");
  assert.equal(after.starts, "2026-11-07T22:00"); assert.equal(after.price, 12);
  assert.ok(g.find((e) => e.title === "KLEIDERTAUSCH PARTY" && e.starts === "2026-11-17T16:00"));
});
await ok("cottbus.de: date (never a date as a time), the run's end, place, category, link", () => {
  const c = E.parseCottbus(FIX("cottbus.html"));
  assert.ok(c.length >= 4);
  assert.ok(c.every((e) => !/T\d{2}:11$/.test(e.starts)), c.map((e) => e.starts).join(" "));
  const ex = c.find((e) => e.tag === "Ausstellung" && e.ends);
  assert.ok(ex); assert.ok(ex.url.startsWith("https://cottbus.de/veranstaltungen/"));
});
await ok("BTU: career and scholarship notices only, a deadline read as the date", () => {
  const b = E.parseBtu(FIX("btu.html"));
  const s = b.find((e) => e.title === "Deutschlandstipendium");
  assert.ok(s); assert.equal(s.starts, "2026-11-15"); assert.equal(s.tag, "Scholarship");
  assert.ok(!b.some((e) => /EUNICE|Energie-Innovationszentrum/.test(e.title)));
});
await ok("Devpost: online or in Germany, with dates and prizes; Ottawa isn't", () => {
  const d = E.parseDevpost(DEVPOST);
  assert.deepEqual(d.map((e) => e.title), ["QNX Global Hackathon", "Berlin Data Jam", "Old One"]);
  assert.equal(d[0].starts, "2026-11-02"); assert.equal(d[0].ends, "2026-12-15"); assert.match(d[0].note, /prizes \$10,000 · IoT/);
  assert.equal(d[1].ends, "2027-01-18");
});
await ok("a Meetup group's calendar feed", () => {
  const m = E.parseIcal(ICS, "meetup");
  assert.equal(m.length, 1); assert.equal(m[0].title, "PyData Berlin, November edition"); assert.equal(m[0].starts, "2026-11-18T18:30");
});
await ok("prices: free words, the lowest amount, or not listed", () => {
  assert.equal(E.priceOf("Eintritt frei"), 0); assert.equal(E.priceOf("OFFENE PROBE"), 0);
  assert.equal(E.priceOf("VVK 8,00€ / Abendkasse: 12,00€"), 8); assert.equal(E.priceOf("ab 19 Uhr"), null);
});

console.log("\n2. the topics");
const CFG = { ...CONFIG, modules: { ...CONFIG.modules, events: true },
  topics: { ...CONFIG.topics, culture_events: 1372, career_events: 1373 },
  events: { max_price: 10, sources: ["cottbus_theater", "gladhouse", "cottbus_city", "devpost", "btu"], meetup_groups: ["pydata-berlin"] } };
const DB = makeDB(); const st = new Store(DB);
await st.kvSet("config", JSON.stringify(CFG));
const ENV = { DB, OPENAI_API_KEY: "k", TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "-100", TELEGRAM_OWNER_ID: "1", WEBHOOK_SECRET: "s" };
const tick = async () => { NOW += 10 * 60_000; const w = []; await worker.scheduled({ cron: E.EVENTS_CRON, scheduledTime: NOW }, ENV, { waitUntil: (p) => w.push(p) }); await Promise.all(w); };
for (let i = 0; i < 14; i++) await tick();
// text cards and photo cards alike (a photo's card is its caption)
const sent = () => net.tg.filter((c) => c.method === "sendMessage" || c.method === "sendPhoto")
  .map((c) => (c.method === "sendPhoto" ? { ...c, body: { ...c.body, text: c.body.caption } } : c));
const reads = () => net.urls.filter((u) => !u.includes("telegram") && !(/staatstheater/.test(u) && !/spielplan/.test(u)));
const row = (q) => DB.raw.prepare(`SELECT * FROM events WHERE ${q}`).all();
await ok("its own trigger at :01: one source per tick, each read once (every 6-12 h)", () => {
  assert.equal(reads().length, 6);                  // 5 sources + 1 meetup group
});
await ok("each topic says hello first, with the budget and how to change it", () => {
  const h = sent().filter((c) => /will be posted here/.test(c.body.text));
  assert.equal(h.length, 2);
  assert.equal(h.find((c) => /Cultural events/.test(c.body.text)).body.message_thread_id, 1372);
  assert.match(h.find((c) => /Cultural/.test(c.body.text)).body.text, /up to 10 € or free/);
  assert.equal(h.find((c) => /Career events/.test(c.body.text)).body.message_thread_id, 1373);
});
await ok("cultural cards in 1372, career cards in 1373; no AI anywhere", () => {
  const cards = sent().filter((c) => !/will be posted here/.test(c.body.text));
  assert.ok(cards.some((c) => c.body.message_thread_id === 1372 && /KLEIDERTAUSCH/.test(c.body.text)));
  assert.ok(cards.some((c) => c.body.message_thread_id === 1373 && /Deutschlandstipendium/.test(c.body.text)));
  assert.ok(!net.urls.some((u) => u.includes("openai")));
});
await ok("over the budget: held back (12 € > 10 €); a hackathon that's over: never posted", () => {
  assert.equal(row("title='EAST SIDE AFTER DARK'")[0].status, "new");
  assert.ok(!sent().some((x) => /EAST SIDE/.test(x.body.text)));
  assert.equal(row("title='Old One'")[0].why, "over");
});
await ok("a show on several dates: one card", () => {
  const titles = row("kind='culture' AND status='posted'").map((r) => r.title);
  assert.equal(titles.length, new Set(titles.map((t) => t.toLowerCase())).size);
});
await ok("weeks ahead: waits ('later'), posted once it's within 3 weeks", () => {
  const sax = row("title LIKE 'SAX AND THE CITY%'")[0];
  if (sax) assert.equal(sax.status, "new");
  const jam = row("title='Berlin Data Jam'")[0];
  assert.ok(jam.status === "posted" || jam.status === "new");      // career events: 60 days ahead
});
await ok("a card: icon, title, when, where, price, link - easy to read", () => {
  const c = sent().find((x) => /KLEIDERTAUSCH/.test(x.body.text)).body.text;
  assert.match(c, /^🎭 <b>KLEIDERTAUSCH PARTY<\/b>\n\n📅 Tue 17 Nov, 16:00\n📍 Glad-House Cottbus\n💶 price not listed\n\n/);
  assert.match(c, /<a href="https:\/\/www\.gladhouse\.de\/">details<\/a>$/);
  const s = sent().find((x) => /Deutschlandstipendium/.test(x.body.text)).body.text;
  assert.match(s, /^🎓 <b>Deutschlandstipendium<\/b>\n\n📅 Sun 15 Nov\n📍 BTU Cottbus-Senftenberg/);
});
await ok("posters: read from Glad-House, cottbus.de, BTU and Devpost; the theatre's from the show's page", () => {
  const g = E.parseGladhouse(FIX("gladhouse.html"));
  assert.ok(g.length >= 2 && g.every((e) => e.image), "glad-house posters");
  assert.ok(g.every((e) => e.image.startsWith("https://image.jimcdn.com/") && e.image.includes("dimension=1000x10000:format=jpg")));
  assert.equal(new Set(g.filter((e) => e.image).map((e) => e.image)).size, g.filter((e) => e.image).length, "each its own poster");
  assert.ok(E.parseCottbus(FIX("cottbus.html")).some((e) => /^https:\/\/cottbus\.de\/wp-content\/uploads\//.test(e.image ?? "")));
  assert.match(E.parseBtu(FIX("btu.html")).find((e) => e.title === "Deutschlandstipendium").image ?? "", /^https:\/\/www\.b-tu\.de\/fileadmin\//);
  assert.equal(E.parseDevpost({ hackathons: [{ ...DEVPOST.hackathons[0], thumbnail_url: "//d1.cloudfront.net/x.png" }] })[0].image, "https://d1.cloudfront.net/x.png");
  const nab = net.tg.find((c) => c.method === "sendPhoto" && /Nabucco/.test(c.body.caption));
  assert.ok(nab, "Nabucco went out as a photo");
  assert.equal(nab.body.photo, "https://www.staatstheater-cottbus.de/cache/img/4760_show.jpg");
  assert.equal(nab.body.message_thread_id, 1372);
  const ff = net.tg.find((c) => /FilmFestival/.test(c.body.text ?? c.body.caption ?? ""));
  if (ff) assert.equal(ff.method, "sendMessage", "no picture on its page: a text card");
  assert.ok(net.tg.filter((c) => c.method === "sendPhoto").every((c) => c.body.caption.length <= 1024));
});
const before = sent().length;
for (let i = 0; i < 12; i++) await tick();
await ok("nothing new to read within 6 hours: nothing fetched, nothing posted twice", () => {
  assert.equal(reads().length, 6);
  const titles = sent().slice(before).map((c) => c.body.text.split("\n")[0]);
  assert.ok(titles.every((t) => !sent().slice(0, before).some((c) => c.body.text.split("\n")[0] === t)));
});

await ok("a show that started earlier today isn't posted (Berlin time)", async () => {
  // the fixtures' first day has a 17:00 show ("Robin Hood"); the clock is past 9:00 UTC = 10:00 in Berlin
  const DB3 = makeDB(); const st3 = new Store(DB3); await st3.kvSet("config", JSON.stringify(CFG));
  for (const k of ["culture_events", "career_events"]) await st3.kvSet("intro:" + k, "1");
  const saved = NOW; NOW = Date.UTC(2026, 10, 7, 19, 51);                 // 20:51 in Berlin
  net.tg = [];
  for (let i = 0; i < 2; i++) { NOW += 60_000; await E.eventsStep({ DB: DB3 }, st3, tg); }
  assert.ok(!sent().some((c) => /Robin Hood/.test(c.body.text)), "Robin Hood started at 17:00");
  assert.equal(DB3.raw.prepare("SELECT why FROM events WHERE title='Robin Hood'").get().why, "over");
  NOW = saved;
});

await ok("a long note is shortened to fit a photo caption (1024)", async () => {
  const DB4 = makeDB(); const st4 = new Store(DB4); await st4.kvSet("config", JSON.stringify(CFG));
  for (const k of ["culture_events", "career_events"]) await st4.kvSet("intro:" + k, "1");
  await E.eventsStep({ DB: DB4 }, st4, tg);                     // creates the table
  DB4.raw.prepare("DELETE FROM events").run();
  DB4.raw.prepare(`INSERT INTO events (id,kind,dkey,title,starts,place,price,url,note,tag,status,first_seen,image)
    VALUES ('x:1','culture','long','Long One','2026-11-20T19:00','Somewhere',0,'https://e.x/','${"blah ".repeat(400)}','','new',0,'https://e.x/p.jpg')`).run();
  for (const k of Object.keys(E.SOURCES)) await st4.kvSet("events_checked:" + k, String(Math.floor(NOW / 1000)));
  net.tg = [];
  await E.eventsStep({ DB: DB4 }, st4, tg);
  const p = net.tg.find((c) => c.method === "sendPhoto");
  assert.ok(p); assert.ok(p.body.caption.length <= 1024, String(p.body.caption.length)); assert.match(p.body.caption, /…/);
  assert.match(p.body.caption, /details<\/a>$/);
});
await ok("a poster Telegram can't fetch: the card goes out as text", async () => {
  const DB5 = makeDB(); const st5 = new Store(DB5); await st5.kvSet("config", JSON.stringify(CFG));
  for (const k of ["culture_events", "career_events"]) await st5.kvSet("intro:" + k, "1");
  await E.eventsStep({ DB: DB5 }, st5, tg);
  DB5.raw.prepare("DELETE FROM events").run();
  DB5.raw.prepare(`INSERT INTO events (id,kind,dkey,title,starts,place,price,url,note,tag,status,first_seen,image)
    VALUES ('x:2','culture','bad','Bad Poster','2026-11-20T19:00','Somewhere',0,'https://e.x/','fine','','new',0,'https://bad-poster/p.jpg')`).run();
  for (const k of Object.keys(E.SOURCES)) await st5.kvSet("events_checked:" + k, String(Math.floor(NOW / 1000)));
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => (String(u).endsWith("/sendPhoto") ? new Response('{"ok":false,"description":"Bad Request: wrong file"}', { status: 400 }) : real(u, i));
  net.tg = [];
  await E.eventsStep({ DB: DB5 }, st5, tg);
  globalThis.fetch = real;
  assert.ok(net.tg.some((c) => c.method === "sendMessage" && /Bad Poster/.test(c.body.text)));
  assert.equal(DB5.raw.prepare("SELECT status FROM events WHERE id='x:2'").get().status, "posted");
});
await ok("cards posted before the posters came: taken down and sent again with the poster", async () => {
  const DB6 = makeDB(); const st6 = new Store(DB6); await st6.kvSet("config", JSON.stringify(CFG));
  for (const k of ["culture_events", "career_events"]) await st6.kvSet("intro:" + k, "1");
  await E.eventsStep({ DB: DB6 }, st6, tg);
  DB6.raw.prepare("DELETE FROM events").run();
  const ins = (id, img, at) => DB6.raw.prepare(`INSERT INTO events (id,kind,dkey,title,starts,place,price,url,note,tag,status,first_seen,posted_at,msg_id,image)
    VALUES (?,'culture',?,?,'2026-11-20T19:00','Somewhere',0,'https://e.x/','n','','posted',0,?,?,?)`).run(id, id, id, at, 77, img);
  ins("x:old-poster", "https://e.x/p.jpg", 100); ins("x:old-none", null, 100); ins("x:new-poster", "https://e.x/q.jpg", Math.floor(NOW / 1000) + 1);
  await st6.kvSet("events_repost_before", String(Math.floor(NOW / 1000)));
  for (const k of Object.keys(E.SOURCES)) await st6.kvSet("events_checked:" + k, String(Math.floor(NOW / 1000)));
  net.tg = [];
  await E.eventsStep({ DB: DB6 }, st6, tg);
  assert.equal(net.tg.filter((c) => c.method === "deleteMessage").length, 1);
  assert.ok(net.tg.some((c) => c.method === "sendPhoto" && /x:old-poster/.test(c.body.caption)));
  assert.equal(DB6.raw.prepare("SELECT status FROM events WHERE id='x:old-none'").get().status, "posted");
  net.tg = [];
  await E.eventsStep({ DB: DB6 }, st6, tg);                    // and only once
  assert.equal(net.tg.filter((c) => c.method === "deleteMessage" || c.method === "sendPhoto").length, 0);
});

console.log("\n3. /events");
const say = async (text, from = 7) => { net.tg = []; await worker.fetch(new Request("https://w/", { method: "POST",
  headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" },
  body: JSON.stringify({ message: { text, from: { id: from }, chat: { id: -100 }, message_thread_id: 1372, is_topic_message: true } }) }), ENV); return sent(); };
let c = await say("/events");
await ok("anyone in the group: the settings, with buttons", () => {
  assert.match(c[0].body.text, /Cultural events: on, up to 10 € or free\nCareer events: on/);
  assert.deepEqual(c[0].body.reply_markup.inline_keyboard.flat().map((b) => b.text), ["−5 €", "≤ 10 €", "+5 €", "🎭 ⏸ pause", "🎤 ⏸ pause"]);
});
c = await say("/events budget 15");
await ok("/events budget 15: the 12 € concert held back goes out on the next tick", async () => {
  assert.match(c[0].body.text, /up to 15 €/);
  assert.equal(await st.kvGet("events_budget"), "15");
  net.tg = []; await tick();
  assert.ok(sent().some((x) => /EAST SIDE AFTER DARK/.test(x.body.text) && /💶 12 €/.test(x.body.text)));
});
c = await say("/events career off");
await ok("/events career off: paused, no more career cards", async () => {
  assert.match(c[0].body.text, /Career events: paused/);
  DB.raw.prepare("UPDATE events SET status='new', why=NULL WHERE kind='career'").run();
  net.tg = []; await tick();
  assert.ok(!sent().some((x) => x.body.message_thread_id === 1373));
});
await ok("/status has an events line", async () => {
  const s = await E.eventsLine(st, DB, (await import(SRC + "config.ts")).normalize(CFG));
  assert.match(s, /^Events: +🎭 \d+ posted \(≤ 15 €\) · 🎤 paused$/);
});
await ok("not in the config: switched off, nothing fetched", async () => {
  const DB2 = makeDB(); const st2 = new Store(DB2); await st2.kvSet("config", JSON.stringify(CONFIG));
  const n = net.urls.length;
  assert.equal(await E.eventsStep({ DB: DB2 }, st2, tg), "events: off");
  assert.equal(net.urls.length, n);
});

console.log(`\nall ${pass} events checks passed`);
