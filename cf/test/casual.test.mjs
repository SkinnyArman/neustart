// Offline tests for src/casual.ts and its wiring. A synthetic Jobbörse
// Minijob search and details, an in-memory D1, recorded Telegram calls.
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
const ad = (ref, title, firma, ort = "Cottbus") => ({ referenznummer: ref, stellenangebotsTitel: title, firma, stellenangebotsart: "ARBEIT", stellenlokationen: [{ adresse: { ort } }] });
const LIST = [
  ad("20001", "Aushilfe im Verkauf (m/w/d)", "Engbers GmbH & Co KG"),
  ad("20002", "Minijob als Reinigungskraft (m/w/d)", "Clean GmbH"),
  ad("20003", "Minijob Ergotherapeut/in Cottbus", "Praxis Weiß"),
  ad("20004", "Berufskraftfahrer als Aushilfe gesucht", "Spedition X"),
  ad("20005", "Tourenfahrer Cottbus (m/w/d) - Vollzeit", "Kurier AG"),
  ad("20006", "Aushilfe im Verkauf (m/w/d)", "Engbers GmbH & Co KG"),             // the same ad again
  ad("20007", "Mini-Job, Teilzeit, Vollzeit Zusteller (m/w/d)", "Zeitung GmbH"),
  ad("20008", "Küchenhilfe (m/w/d) Schule", "Catering GmbH", "Kolkwitz"),
  ad("20009", "Aushilfe (m/w/d)", "Engbers GmbH & Co KG", "Spremberg"),           // same title, other town: its own card
  ad("20010", "Hausmeister (m/w/d) Minijob", "Wohnbau eG"),
];
const LONG = "Wir sind ein Modehaus in der Innenstadt. ".repeat(10) + "Deine Aufgaben: Kasse, Beratung, Ware einräumen.\nDas bringst du mit: Freundlichkeit. ".repeat(4);
const DETAILS = {
  "20001": { stellenangebotsBeschreibung: "<p>Kasse und Beratung.</p><p>Bezahlung nach Tarif.</p>", verguetungsangabe: "STUNDENLOHN", artDerVerguetung: "FESTGEHALT", festgehalt: 15,
    arbeitszeitTeilzeitVormittag: true, arbeitszeitTeilzeitAbend: true, eintrittszeitraum: { von: "2026-11-01" }, externeURL: "https://engbers.example/apply" },
  "20002": { stellenangebotsBeschreibung: "Reinigung von Büros, 14,50 € pro Stunde, abends.", verguetungsangabe: "KEINE_ANGABEN", arbeitszeitTeilzeitFlexibel: true, eintrittszeitraum: { von: "2026-06-27" } },
  "20007": { stellenangebotsBeschreibung: LONG, verguetungsangabe: "KEINE_ANGABEN" },
  "20008": null,                                                                   // taken down meanwhile: 404
  "20009": { stellenangebotsBeschreibung: "Aushilfe in der Filiale Spremberg.", verguetungsangabe: "KEINE_ANGABEN" },
  "20010": { stellenangebotsBeschreibung: "Kleine Reparaturen, Winterdienst.", verguetungsangabe: "KEINE_ANGABEN" },
};

// ---------------------------------------------------------------- network
const net = { search: 0, searchUrl: null, details: [], tg: [], ai: 0 };
let msgId = 500;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("/pc/v6/jobs")) { net.search++; net.searchUrl = new URL(url); return Response.json({ ergebnisliste: LIST }); }
  if (url.includes("/jobdetails/")) {
    const ref = new TextDecoder().decode(Uint8Array.from(atob(url.split("/").pop()), (c) => c.charCodeAt(0)));
    net.details.push(ref);
    return DETAILS[ref] ? Response.json(DETAILS[ref]) : new Response("not found", { status: 404 });
  }
  if (url.includes("api.openai.com")) { net.ai++; throw new Error("no AI here"); }
  if (url.includes("api.telegram.org")) {
    net.tg.push({ method: url.split("/").pop(), body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: { message_id: ++msgId } });
  }
  throw new Error("unexpected fetch " + url);
};
console.error = () => {};

const C = await import(SRC + "casual.ts");
const { Store } = await import(SRC + "store.ts");
const { Telegram } = await import(SRC + "telegram.ts");
const worker = (await import(SRC + "index.ts")).default;

let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ✓", name); };
const DB = makeDB(); const st = new Store(DB);
const E = { DB, OPENAI_API_KEY: "k", TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "-100", TELEGRAM_OWNER_ID: "1", WEBHOOK_SECRET: "s" };
await st.kvSet("config", JSON.stringify(CONFIG));                 // Cottbus, 25 km, topic 992
const tg = new Telegram("T", "-100");
const row = (id) => DB.raw.prepare("SELECT * FROM casual WHERE id=?").get(id);
const cards = () => net.tg.filter((c) => c.method === "sendMessage");
const cardOf = (t) => cards().find((c) => c.body.text.includes(t))?.body.text;

console.log("\n1. rules");
await ok("trades, licences, apprenticeships and plain full-time titles are left out", () => {
  for (const t of ["Minijob Ergotherapeut/in", "Pflegefachkraft (m/w/d) Minijob", "Berufskraftfahrer als Aushilfe", "Erzieher / Pferde",
    "Ausbilder Erste Hilfe (m/w/d)", "Tourenfahrer (m/w/d) - Vollzeit", "Ausbildung Verkäufer"])
    assert.ok(C.casualRejectReason(t), t);
  for (const t of ["Aushilfe im Verkauf (m/w/d)", "Minijob als Reinigungskraft", "Mini-Job, Teilzeit, Vollzeit Zusteller (m/w/d)",
    "Küchenhilfe (m/w/d)", "Hausmeister (m/w/d) Minijob", "Ordnungsdienst für Veranstaltungen (m/w/d)",
    "Gebäudereiniger (m/w/d) Cottbus Kolkwitz", "Minijob - Zeitung austragen in Kolkwitz"])
    assert.equal(C.casualRejectReason(t), null, t);
});
await ok("pay: the wage field, else a euro amount in the text, else nothing", () => {
  assert.equal(C.payOf({ verguetungsangabe: "STUNDENLOHN", festgehalt: 15 }, ""), "€15/h");
  assert.equal(C.payOf({ festgehalt: 13.9 }, ""), "€13,9/h");
  assert.equal(C.payOf({ festgehalt: 603, verguetungsangabe: "MONATSGEHALT" }, ""), "€603/month");
  assert.equal(C.payOf({}, "Wir zahlen 14,50 € pro Stunde."), "€14,50/h (from the ad)");
  assert.equal(C.payOf({}, "auf Minijob-Basis 603 € im Monat"), "€603 (from the ad)");
  assert.equal(C.payOf({}, "Bezahlung nach Absprache"), "");
});

await ok("description: markdown out, bullets as •, from the tasks on after a long company intro", () => {
  const d = C.describe("<p>**Wir sind** ein großes Unternehmen. " + "Wir wachsen seit Jahren. ".repeat(8) + "</p><h2>## Deine Aufgaben</h2><p>* Kasse</p><p>- Ware einräumen</p><p>✓ Rabatt</p>");
  assert.equal(d, "Deine Aufgaben\n• Kasse\n• Ware einräumen\n• Rabatt");
  assert.match(C.describe("<p>Kurz: wir sind nett.</p><p>Deine Aufgaben: Kasse</p>"), /^Kurz: wir sind nett\./);   // short intro stays
});

console.log("\n2. a tick");
const tick = async (minute = 7) => {
  const t = Date.UTC(2026, 9, 29, 10, minute);
  Date.now = () => t;                                              // the minute the trigger fires
  const w = [];
  await worker.scheduled({ cron: C.CASUAL_CRON, scheduledTime: Date.UTC(2026, 9, 29, 10, minute) }, E, { waitUntil: (p) => w.push(p) });
  await Promise.all(w);
};
net.tg = []; await tick();
await ok("the :07 trigger runs it: one Minijob search around Cottbus, last 30 days", () => {
  assert.equal(net.search, 1);
  const q = net.searchUrl.searchParams;
  assert.equal(q.get("wo"), "Cottbus"); assert.equal(q.get("umkreis"), "25");
  assert.equal(q.get("arbeitszeit"), "mj"); assert.equal(q.get("veroeffentlichtseit"), "30");
});
await ok("rules applied before anything is fetched; the same ad twice is one row", () => {
  assert.equal(row("ba:20003").why, "needs a qualification");
  assert.equal(row("ba:20004").why, "needs a qualification");
  assert.equal(row("ba:20005").why, "full-time");
  assert.equal(row("ba:20006"), undefined);
  assert.ok(row("ba:20009"));
  assert.ok(!net.details.some((r) => ["20003", "20004", "20005"].includes(r)));
});
await ok("5 cards per tick, into topic 992, no buttons, no AI", () => {
  assert.equal(cards().length, 4);                                // 5 tried, one was gone (404)
  assert.ok(cards().every((c) => c.body.message_thread_id === 992 && !c.body.reply_markup));
  assert.equal(net.ai, 0);
  assert.equal(row("ba:20008").status, "skipped"); assert.equal(row("ba:20008").why, "gone");
});
await ok("card: title, company and town, pay, times, start, description, links", () => {
  const c = cardOf("Engbers GmbH &amp; Co KG · Cottbus");
  console.log("   card:\n     " + c.split("\n").join("\n     "));
  assert.match(c, /^🧺 <b>Aushilfe im Verkauf \(m\/w\/d\)<\/b>\nEngbers GmbH &amp; Co KG · Cottbus\n\n/);
  assert.match(c, /\n\n💶 €15\/h\n🕐 mornings · evenings\n📅 from 01\.11\.\n\n/);
  assert.match(c, /\n\nKasse und Beratung\.\nBezahlung nach Tarif\.\n\n/);
  assert.match(c, /<a href="https:\/\/www\.arbeitsagentur\.de\/jobsuche\/jobdetail\/20001">open the job<\/a> · <a href="https:\/\/engbers\.example\/apply">apply<\/a>$/);
  assert.equal(row("ba:20001").pay, "€15/h");
});
await ok("a start date that has passed isn't shown", () => assert.ok(!/📅/.test(cardOf("Clean GmbH"))));
await ok("pay from the text when the field is empty; 'not stated' when there is none", () => {
  assert.match(cardOf("Clean GmbH"), /💶 €14,50\/h \(from the ad\)\n🕐 flexible/);
  assert.match(cardOf("Zeitung GmbH"), /💶 pay not stated \(at least minimum wage\)/);
});
await ok("a long description is cut at a sentence end", () => {
  const c = cardOf("Zeitung GmbH");
  const body = c.split("\n\n")[2];
  assert.ok(body.length < 650, String(body.length));
  assert.match(body, /\. …$/);
});
net.tg = []; net.details = []; await tick(17);
await ok("next tick: no new search (every 30 min), the rest of the queue is posted", () => {
  assert.equal(net.search, 1);
  assert.equal(cards().length, 1);
  assert.match(cards()[0].body.text, /Hausmeister/);
});
net.tg = []; await tick(27);
await ok("nothing left: nothing sent", () => assert.equal(cards().length, 0));
net.tg = []; await tick(37);
await ok("after 30 min it searches again, but known ads aren't posted twice", () => {
  assert.equal(net.search, 2);
  assert.equal(cards().length, 0);
});
await ok("/status has a casual jobs line", async () => {
  assert.match(await C.casualLine(st, DB), /Casual jobs: +✅ 5 posted, checked/);
});
await st.kvSet("casual_on", "0");
net.tg = []; await st.kvSet("casual_searched_at", "0"); await tick(47);
await ok("kv casual_on=0 pauses it", () => { assert.equal(net.search, 2); assert.equal(cards().length, 0); });

console.log(`\nall ${pass} casual checks passed`);
