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
await st.kvSet("intro:casual_jobs", "1");                          // said hello already
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
  assert.match(await C.casualLine(st, DB), /Casual jobs: +✅ 5 posted within 25 km of Cottbus, checked/);
});
await st.kvSet("casual_on", "0");
net.tg = []; await st.kvSet("casual_searched_at", "0"); await tick(47);
await ok("kv casual_on=0 pauses it", () => { assert.equal(net.search, 2); assert.equal(cards().length, 0); });

console.log("\n3. /casual: which town, how far around it");
await st.kvSet("casual_on", "1");
const say = async (text, from = 7, chat = -100) => {
  net.tg = [];
  await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" },
    body: JSON.stringify({ message: { text, from: { id: from }, chat: { id: chat }, message_thread_id: 992, is_topic_message: true } }) }), E);
  return net.tg;
};
const press = async (data) => {
  net.tg = [];
  await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query: { id: "q", data, from: { id: 7 }, message: { chat: { id: -100 }, message_id: 50 } } }) }), E);
  return net.tg;
};
let c = await say("/casual");
await ok("/casual (anyone in the group): where it looks, with buttons, in the Minijobs topic", () => {
  const m = c.find((x) => x.method === "sendMessage");
  assert.match(m.body.text, /^🧺 <b>Minijobs<\/b> within 25 km of Cottbus\n/);
  assert.equal(m.body.message_thread_id, 992);
  assert.deepEqual(m.body.reply_markup.inline_keyboard.flat().map((b) => b.text), ["−5 km", "25 km", "+5 km", "⬜ only Cottbus itself", "⏸ Pause", "🔄 Check now"]);
});
const spremberg = row("ba:20009");
assert.equal(spremberg.status, "posted");
c = await say("/casual only on");
await ok("/casual only on: the card from Spremberg comes down; the Cottbus ones stay", () => {
  assert.match(c.find((x) => x.method === "sendMessage").body.text, /only Cottbus itself - took down 1 card from other towns/);
  assert.deepEqual(c.filter((x) => x.method === "deleteMessage").map((x) => x.body.message_id), [spremberg.msg_id]);
  assert.equal(row("ba:20009").status, "skipped"); assert.equal(row("ba:20009").why, "not in Cottbus");
  assert.equal(row("ba:20001").status, "posted");
});
LIST.push(ad("20011", "Aushilfe Bäckerei (m/w/d)", "Bäcker Lehmann", "Kolkwitz, Niederlausitz"), ad("20012", "Aushilfe Kino (m/w/d)", "Kino Cottbus", "Cottbus"));
DETAILS["20012"] = { stellenangebotsBeschreibung: "Kasse im Kino.", verguetungsangabe: "KEINE_ANGABEN" };
net.tg = []; await tick(57);
await ok("…and new ads from the towns around it aren't posted", () => {
  assert.equal(row("ba:20011").why, "not in Cottbus");
  assert.ok(cards().some((x) => /Kino Cottbus/.test(x.body.text)));
  assert.ok(!cards().some((x) => /Lehmann/.test(x.body.text)));
});
c = await say("/casual 10");
await ok("/casual 10: 10 km, and it looks again on the next tick", async () => {
  assert.match(c[0].body.text, /10 km around Cottbus/);
  net.tg = []; const before = net.search; await tick(7);
  assert.equal(net.search, before + 1); assert.equal(net.searchUrl.searchParams.get("umkreis"), "10");
});
c = await press("cj:radius:+5");
await ok("the buttons: +5 km → 15, edited in place", () => {
  assert.equal(c.find((x) => x.method === "answerCallbackQuery").body.text, "🧺 Minijobs: 15 km around Cottbus");
  assert.match(c.find((x) => x.method === "editMessageText").body.text, /in Cottbus only/);
});
c = await press("cj:only:off");
await ok("…only off: the towns around it again", async () => {
  assert.equal(await st.kvGet("casual_only_city"), "0");
  assert.match(c.find((x) => x.method === "editMessageText").body.text, /within 15 km of Cottbus/);
});
c = await say("/casual city Spremberg");
await ok("/casual city Spremberg: searched there from the next tick", async () => {
  net.tg = []; await tick(17);
  assert.equal(net.searchUrl.searchParams.get("wo"), "Spremberg");
  await say("/casual city Cottbus");
  assert.equal(await st.kvGet("casual_city"), "");
});
c = await say("/casual banana");
await ok("anything else gets the usage", () => assert.match(c[0].body.text, /^Try \/casual/));
c = await say("/casual", 9, 9);
await ok("not from a stranger in a private chat", () => assert.match(c[0].body.text, /only answers to them/));
await ok("only_city in the config does the same without a command", async () => {
  const { normalize } = await import(SRC + "config.ts");
  const { whereOf } = await import(SRC + "casual.ts");
  const DB2 = makeDB(); const st2 = new Store(DB2);
  assert.deepEqual(await whereOf(st2, normalize({ ...CONFIG, casual_jobs: { radius_km: 20, only_city: true } })), { city: "Cottbus", radius: 20, only: true });
  assert.equal(C.inTown("Cottbus, Sandow", "Cottbus"), true); assert.equal(C.inTown("Kolkwitz, Niederlausitz", "Cottbus"), false);
});

console.log("\n4. more sources: part-time jobs and Kleinanzeigen Nebenjobs");
await ok("part-time titles: casual work only - trades, office and teaching jobs stay out", () => {
  for (const t of ["Verkäufer Teilzeit (m/w/d)", "Reinigungskraft (m/w/d) – Büroreinigung | 20,25 Std./Woche", "Mitarbeiter Warenverräumung Backwaren (m/w/d)",
    "Service- und Reinigungshilfe (m/w/d) in Cottbus", "Studentenjob im Verkauf Teilzeit (m/w/d)", "Sicherheitsdienst / Revierfahrer / Security m/w/d"])
    assert.equal(C.partTimeRejectReason(t), null, t);
  for (const t of ["Mitarbeiter (m/w/d) Team Steuern im Finanz- und Rechnungswesen", "Lehrkraft (m/w/d) für Ersthelfer- und Breitenausbildung",
    "Vertriebsmitarbeiter im Innendienst (m/w/d) SHK Branche", "Mitarbeiter (m/w/d) im qualifizierten Patiententransport", "Pflegefachkraft Teilzeit"])
    assert.ok(C.partTimeRejectReason(t), t);
});
await ok("Kleinanzeigen titles: portal ads and sales schemes stay out", () => {
  for (const t of ["⭐ Job / Arbeit ⭐ Aushilfe (m/w/d) - Netto", "Nebenjob/ Minijob Nachhilfelehrer*in gesucht Cottbus (~15-20€)",
    "☎️ NEBENJOB: Rezeption im Hotel - SPREMBERG - 16,50 €/h", "Winterdienstmitarbeiter (m/w/d) Minijob in Cottbus"])
    assert.equal(C.kaJobRejectReason(t), null, t);
  for (const t of ["Babysitter finden in Cottbus (ab 14 €/h) – kostenlose Suche", "Reinigungskraft vor Ort ab 14 €/Std finden (Cottbus)",
    "Ernährungsberater für Hunde und Katzen - Homeoffice", "Baugeräteführer (m/w/d) zur sofortigen Einstellung"])
    assert.ok(C.kaJobRejectReason(t), t);
});
await ok("a town with its postcode is still that town", () => {
  assert.equal(C.inTown("03046 Cottbus", "Cottbus"), true); assert.equal(C.inTown("03130 Spremberg", "Cottbus"), false);
});
{
  const tz = (ref, title, ort = "Cottbus") => ({ referenznummer: ref, stellenangebotsTitel: title, firma: "Firma " + ref, stellenangebotsart: "ARBEIT", stellenlokationen: [{ adresse: { ort } }] });
  const TZ = [tz("30001", "Verkäufer Teilzeit (m/w/d)"), tz("30002", "Mitarbeiter (m/w/d) Team Steuern im Finanz- und Rechnungswesen"),
    tz("30003", "Reinigungskraft (m/w/d) – Büroreinigung | 20,25 Std./Woche"), { ...LIST[0] }];       // the last one is a Minijob too
  const kaCard = ([id, title, place, km, date]) =>
    `<article class="aditem" data-adid="${id}" data-href="/s-anzeige/x-${id}/${id}-107-7743"><div><svg></svg><span>${place}</span><span class="k">(${km} km)</span></div>` +
    `<div><svg></svg><span>${date}</span></div><h3><a class="t" href="/s-anzeige/x-${id}/${id}-107-7743">${title}</a></h3><p class="mb-xsmall">Kurz</p></article>`;
  const KA = `<html>${[
    [701, "⭐ Job / Arbeit ⭐ Aushilfe (m/w/d) - Netto", "03046 Cottbus", 2, "Gestern"],
    [702, "Nebenjob/ Minijob Nachhilfelehrer*in gesucht Cottbus (~15-20€)", "03044 Cottbus", 1, "Heute"],
    [703, "Babysitter finden in Cottbus (ab 14 €/h) – kostenlose Suche", "03046 Cottbus", 1, "Heute"],
    [704, "Zeitung austragen, Teilzeitjob, Nebenjob, Minijob in Spremberg", "03130 Spremberg", 20, "Heute"],
    [705, "Aushilfe Getränkemarkt", "03046 Cottbus", 1, "01.09.2026"],
  ].map(kaCard).join("")}${" ".repeat(3000)}</html>`;
  const seen = { tz: 0, ka: [], kaAd: [] };
  const f0 = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    u = String(u);
    if (u.includes("/pc/v6/jobs") && new URL(u).searchParams.get("arbeitszeit") === "tz") { seen.tz++; net.searchUrl = new URL(u); return Response.json({ ergebnisliste: TZ }); }
    if (u.includes("/jobdetails/") && /^3000/.test(new TextDecoder().decode(Uint8Array.from(atob(u.split("/").pop()), (c) => c.charCodeAt(0)))))
      return Response.json({ stellenangebotsBeschreibung: "Kasse, Regale. 20 Stunden pro Woche.", verguetungsangabe: "KEINE_ANGABEN" });
    if (u.includes("kleinanzeigen.de/s-anzeige/")) { seen.kaAd.push(u); return new Response(`<html><p id="viewad-description-text">Wir suchen Unterstützung an der Kasse, 12 € pro Stunde.</p></html>`); }
    if (u.includes("kleinanzeigen.de")) { seen.ka.push(u); return new Response(KA); }
    return f0(u, i);
  };
  const DB2 = makeDB(); const st2 = new Store(DB2);
  await st2.kvSet("config", JSON.stringify({ ...CONFIG, casual_jobs: { radius_km: 25, only_city: true, sources: ["minijobs", "part_time", "kleinanzeigen"] } }));
  await st2.kvSet("intro:casual_jobs", "1");
  const E2 = { ...E, DB: DB2 };
  const row2 = (id) => DB2.raw.prepare("SELECT * FROM casual WHERE id=?").get(id);
  const tick2 = async (minute) => { const t = Date.UTC(2026, 9, 29, 10, minute); Date.now = () => t;
    const w = []; await worker.scheduled({ cron: C.CASUAL_CRON, scheduledTime: t }, E2, { waitUntil: (p) => w.push(p) }); await Promise.all(w); };
  net.tg = []; await tick2(7);
  await ok("part-time: a Jobbörse search with arbeitszeit=tz around Cottbus; only casual work kept; a job found as both isn't doubled", () => {
    assert.equal(seen.tz, 1); assert.equal(net.searchUrl.searchParams.get("wo"), "Cottbus");
    assert.equal(row2("bt:30002").why, "not casual work");
    assert.ok(row2("bt:30001")); assert.equal(row2("bt:" + LIST[0].referenznummer), undefined);
  });
  await ok("Kleinanzeigen: the Mini- & Nebenjobs category around Cottbus; spam, other towns and old ads stay out", () => {
    assert.ok(seen.ka.some((u) => u === "https://www.kleinanzeigen.de/s-jobs/mini-nebenjobs/cottbus/anzeige:angebote/c107l7743r25"), seen.ka.join("\n"));
    const r = (n) => DB2.raw.prepare("SELECT * FROM casual WHERE id LIKE ?").get(`kj:%/${n}-107-7743`);
    assert.equal(r(703).status, "skipped"); assert.equal(r(704).why, "not in Cottbus"); assert.match(r(705).why, /old ad/);
    assert.notEqual(r(701).status, "skipped"); assert.notEqual(r(702).status, "skipped");
  });
  for (const m of [17, 27, 37]) await tick2(m);
  await ok("cards: a part-time one says so; a Kleinanzeigen one links there, with the pay from the title", () => {
    const vk = cards().find((c) => /Verkäufer Teilzeit/.test(c.body.text));
    assert.ok(vk); assert.match(vk.body.text, /⏱ part-time - check the hours/);
    const nh = cards().find((c) => /Nachhilfelehrer/.test(c.body.text));
    assert.ok(nh, cards().map((c) => c.body.text.split("\n")[0]).join(" | "));
    assert.match(nh.body.text, /💶 €15-20 \(from the ad\)|💶 €20 \(from the ad\)|💶 €15/);
    assert.match(nh.body.text, /<a href="https:\/\/www\.kleinanzeigen\.de\/s-anzeige\/x-702\/702-107-7743">open on Kleinanzeigen<\/a>/);
    assert.ok(cards().every((c) => c.body.message_thread_id === 992));
  });
  globalThis.fetch = f0;
  await ok("without sources in the config: Minijobs only, as before", async () => {
    const { normalize } = await import(SRC + "config.ts");
    assert.deepEqual(normalize(CONFIG).casual_jobs.sources, ["minijobs"]);
    assert.deepEqual(normalize({ ...CONFIG, casual_jobs: { sources: ["kleinanzeigen", "bogus"] } }).casual_jobs.sources, ["kleinanzeigen"]);
  });
}

console.log("\n5. what the cards show");
{
  const { unescapeHtml } = await import(SRC + "scraper.ts");
  await ok("hex and decimal HTML codes are decoded: Student&#x2F;-in is Student/-in", () => {
    assert.equal(unescapeHtml("Student&#x2F;-in, Rentner&#x2F;-in &#x27;ja&#39; &amp; mehr"), "Student/-in, Rentner/-in 'ja' & mehr");
  });
  await ok("a pay range stays a range", () => {
    assert.equal(C.payOf({}, "Nachhilfelehrer*in gesucht Cottbus (~15-20€)"), "€15-20 (from the ad)");
    assert.equal(C.payOf({}, "zwischen 15 - 20 € pro Stunde"), "€15-20/h (from the ad)");
    assert.equal(C.payOf({}, "16,50 €/h"), "€16,50/h (from the ad)");
  });
  await ok("a Kleinanzeigen card: no decoration lines, the link is readable", () => {
    const text = "✨ WIR SUCHEN: ✨\n► Aushilfe (m/w/d)\n➖➖➖➖➖➖➖➖\n➡️ BEWERBUNG direkt über den Button, ODER öffne diesen Link:\nhttps://jobino.jobs/3UOufMh\n━━━━━━━━\nFür unsere Filialen suchen wir Sie.";
    const c = C.kaJobCard({ id: "kj:/s-anzeige/x/1-107-7743", title: "Aushilfe - Netto", company: "", place: "03048 Cottbus", attempts: 0 }, text);
    assert.ok(!/➖|━/.test(c), c);
    assert.match(c, /https:\/\/jobino\.jobs\/3UOufMh/);
  });
}

console.log("\n6. worth it or not");
{
  const ABOUT = "Help out in a supermarket: stocking shelves and working the till, a few afternoons a week. Basic German needed.";
  const ai = { calls: [], verdict: { verdict: "worth", why: "€15.33/h for light office cleaning, close by", about: ABOUT }, down: false };
  const f0 = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    u = String(u);
    if (u.includes("api.openai.com")) {
      const body = JSON.parse(i.body); ai.calls.push(body);
      if (ai.down) return new Response('{"error":"overloaded"}', { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ai.verdict) } }] }));
    }
    return f0(u, i);
  };
  const DB3 = makeDB(); const st3 = new Store(DB3);
  await st3.kvSet("config", JSON.stringify({ ...CONFIG, casual_jobs: { radius_km: 25, worth_it: true } }));
  await st3.kvSet("intro:casual_jobs", "1");
  const E3 = { ...E, DB: DB3, OPENAI_API_KEY: "k", FINDS_MODEL: "gpt-5.6-luna" };
  const run3 = async (minute) => { const t = Date.UTC(2026, 9, 29, 11, minute); Date.now = () => t;
    const w = []; await worker.scheduled({ cron: C.CASUAL_CRON, scheduledTime: t }, E3, { waitUntil: (p) => w.push(p) }); await Promise.all(w); };
  net.tg = []; await run3(7);
  const first = cards()[0];
  await ok("each card gets a verdict from the cheap model, weighing the work against the pay", () => {
    assert.ok(ai.calls.length >= 1);
    assert.equal(ai.calls[0].model, "gpt-5.6-luna");
    assert.match(ai.calls[0].messages[0].content, /worth[\s\S]*minimum wage/);
    assert.match(ai.calls[0].messages[1].content, /Title: Aushilfe im Verkauf/);
  });
  await ok("the verdict is the first thing under the title, easy to read", () => {
    const lines = first.body.text.split("\n");
    assert.match(lines[0], /^🧺 <b>/);
    assert.equal(lines[2], "");
    assert.equal(lines[3], "✅ <b>Worth it</b>");
    assert.equal(lines[4], "<i>€15.33/h for light office cleaning, close by</i>");
  });
  await ok("numeric codes in the text come out as characters (\"Aufgaben:&amp;#160;\" was shown raw)", () => {
    assert.equal(C.describe("<p>Deine Aufgaben:&amp;#160;</p><p>Kasse &#8211; Lager</p>"), "Deine Aufgaben:\nKasse – Lager");
  });
  await ok("a short English paragraph on what the job is, before a shorter taste of the German text", () => {
    const parts = first.body.text.split("\n\n");
    const i = parts.indexOf(`🇬🇧 ${ABOUT}`);
    assert.ok(i > 0, first.body.text);
    assert.match(parts[i - 1], /^💶 /);                         // after the facts
    assert.ok(parts[i + 1].length <= 310, String(parts[i + 1].length));
    assert.match(ai.calls[0].messages[0].content, /about: the job in plain English/);
  });
  ai.verdict = { verdict: "not", why: "Night shifts lifting crates for minimum wage" };
  net.tg = []; await run3(17);
  await ok("…not worth it says so too", () => assert.ok(cards().some((c) => /\n\n❌ <b>Not worth it<\/b>\n<i>Night shifts/.test(c.body.text))));
  ai.down = true;
  DB3.raw.prepare("UPDATE casual SET status='new' WHERE id='ba:20010'").run();
  net.tg = []; await run3(27);
  await ok("the AI down: the card still goes out, without a verdict", () => {
    const c = cards().find((x) => /Hausmeister/.test(x.body.text));
    assert.ok(c); assert.ok(!/Worth it|worth it/.test(c.body.text)); assert.ok(!/🇬🇧/.test(c.body.text));
  });
  ai.down = false;
  // re-post: cards posted from a time on come down and go out again
  const before = DB3.raw.prepare("SELECT id, msg_id FROM casual WHERE status='posted' ORDER BY id").all();
  await st3.kvSet("casual_repost", String(Math.floor(Date.UTC(2026, 9, 29, 11, 15) / 1000)));
  net.tg = []; await run3(37);
  await ok("kv casual_repost=<time>: the cards posted since then are deleted and posted again; older ones stay", async () => {
    const del = net.tg.filter((c) => c.method === "deleteMessage").map((c) => c.body.message_id);
    assert.ok(del.length >= 1);
    assert.ok(!del.includes(DB3.raw.prepare("SELECT msg_id FROM casual WHERE id='ba:20001'").get().msg_id), "the first card (11:07) stays");
    assert.equal(await st3.kvGet("casual_repost"), "0");
    assert.ok(cards().length >= 1);
  });
  globalThis.fetch = f0;
  await ok("without worth_it in the config: no AI at all, as before", async () => {
    const { normalize } = await import(SRC + "config.ts");
    assert.equal(normalize(CONFIG).casual_jobs.worth_it, false);
  });
}

console.log(`\nall ${pass} casual checks passed`);
