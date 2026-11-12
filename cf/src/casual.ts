// Casual jobs - Minijobs around the config's city (Aushilfe, Verkauf,
// Reinigung, Zeitung austragen, Küchenhilfe, …) - posted to their own topic.
// No AI and no buttons: each card is the job, the pay, the hours and the
// description.
//
// Sources (casual_jobs.sources in the config; Minijobs alone by default):
//   - minijobs: the Jobbörse's Minijob filter, every 30 minutes
//   - part_time: its part-time filter too, kept to casual work by title
//     (Verkauf, Reinigung, Service, Lager…), not office or teaching jobs
//   - kleinanzeigen: its Mini- & Nebenjobs category, hourly, without the
//     job portals' own ads and sales schemes
// For the Jobbörse: Its details give
// the hourly wage when the employer filled it in (about one ad in five) and
// which times of day the job is for. Titles that need a trade or a licence
// (Pflegefachkraft, Erzieher, Berufskraftfahrer, …) are left out by a word list.
//
// Where: the config's city and radius, or what /casual set since (kv
// casual_city, casual_radius, casual_only_city - they win over the config).
// "Only the city itself" drops the towns around it, and switching it on
// takes down the cards already posted from them.

import { aiFailed, aiWorked } from "./aikey.ts";
import { loadConfig, NO_CONFIG, type Config } from "./config.ts";
import { strip } from "./jobs.ts";
import { KA_BASE, parseAd as kaParseAd, parseListing as kaParseListing } from "./kleinanzeigen.ts";
import { Blocked, get, type CookieJar } from "./scraper.ts";
import { blockSecondsLeft, fmtLeft } from "./settings.ts";
import type { Store } from "./store.ts";
import { esc, inTopic, type Button, type Telegram } from "./telegram.ts";
import { introduce, topicOf } from "./topics.ts";
import { noteError, noteOk } from "./watch.ts";

export const CASUAL_CRON = "7,17,27,37,47,57 * * * *";
const SEARCH_EVERY = 30 * 60;
const KA_EVERY = 60 * 60;
const KA_MAX_AGE_DAYS = 14;              // a job ad a week or two old is often still open
const POST_PER_TICK = 5;
const MAX_ATTEMPTS = 3;

const BA = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service";
const BA_KEY = { "X-API-Key": "jobboerse-jobsuche" };   // the Jobbörse's public client key

export interface CasualEnv { DB: D1Database; OPENAI_API_KEY?: string; FINDS_MODEL?: string }

const now = () => Math.floor(Date.now() / 1000);
const date = (iso?: string) => (iso ? iso.slice(0, 10).split("-").reverse().slice(0, 2).join(".") + "." : "");

// ---------------------------------------------------------------- rules
// needs a qualification or a licence nobody gets on the side
const QUALIFIED = /fachkraft|pflegekraft|pflegefach|altenpfleg|krankenpfleg|therapeut|physio|logopäd|erzieher|(?<!nachhilfe)lehrer|ausbilder|dozent|arzt|ärzt|apothek|hebamme|sozialpäd|psycholog|berufskraftfahrer|\blkw\b|bus ?fahrer|baumaschin|baugerät|geräteführer|kranführer|elektri|mechani|mechatron|(?<!haus)meister|ingenieur|steuerfach|buchhalt|bilanz|medizinische|zahnmed|nageldesign|wimpern|kosmetik|friseur|anwalt|jurist/;
// leading people or a site: wants training and experience, not a side job
// (named one by one: "-leiter" alone would catch Alltagsbegleiter)
const LEAD = /objektleit|teamleit|schichtleit|filialleit|marktleit|bereichsleit|abteilungsleit|projektleit|standortleit|betriebsleit|niederlassungsleit|gruppenleit|kolonnenführ|vorarbeiter|polier|führungskraft|supervisor|team ?lead|manager|stellv(\.|ertret)|disponent/;
const FULL_TIME = /vollzeit|full[- ]?time/;
const CASUAL = /mini-?job|aushilf|teilzeit|nebenjob|werkstudent/;

/** Why a casual job is left out, by its title, or null. */
export function casualRejectReason(title: string): string | null {
  const t = title.toLowerCase();
  if (QUALIFIED.test(t)) return "needs a qualification";
  if (LEAD.test(t)) return "a lead role";
  if (/\b(ausbildung|azubi|duales studium)\b/.test(t)) return "apprenticeship";
  if (FULL_TIME.test(t) && !CASUAL.test(t)) return "full-time";
  return null;
}

// part-time jobs have to be casual work by their title
const CASUAL_WORK = /aushilf|verkäuf|verkauf|kasse|kassier|service|kellner|küchenhilfe|spülkraft|reinigung|lager|kommission|(?<!erst)helfer|zusteller|austräger|hausmeister|empfang|rezeption|kundenservice|call ?center|promot|nebenjob|minijob|studentenjob|werkstudent|barista|bäckerei|backwaren|gastro|housekeep|zimmer|warenverräum|regal|kurier|security|sicherheitsdienst|alltagshilfe/;

/** Why a part-time job is left out, by its title, or null. */
export function partTimeRejectReason(title: string): string | null {
  return casualRejectReason(title) ?? (CASUAL_WORK.test(title.toLowerCase()) ? null : "not casual work");
}

// Kleinanzeigen's job category carries the job portals' own ads ("Babysitter
// finden… kostenlose Suche") and work-from-home sales schemes
const KA_SPAM = /\bfinden\b|kostenlose suche|ernährungsberater|von zu ?hause|network|provision|selbstständig|freiberuf|krypto|trading|forex/;

/** Why a Kleinanzeigen job ad is left out, by its title, or null. */
export function kaJobRejectReason(title: string): string | null {
  const t = title.toLowerCase();
  return KA_SPAM.test(t) ? "portal ad or sales scheme" : casualRejectReason(title);
}

/** The same ad posted twice (or per branch with the same town): one card. */
const dedupeKey = (company: string, title: string, place: string) =>
  [company, title.replace(/\((m|w|d|f|x)[^)]*\)/gi, ""), place].join("|").toLowerCase().replace(/[^\p{L}\d|]+/gu, "").slice(0, 160);

// ---------------------------------------------------------------- storage
const ready = new WeakSet<D1Database>();
async function ensureTable(db: D1Database) {
  if (ready.has(db)) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS casual (id TEXT PRIMARY KEY, dkey TEXT, title TEXT, company TEXT, place TEXT,
       status TEXT NOT NULL, why TEXT, pay TEXT, attempts INTEGER NOT NULL DEFAULT 0,
       first_seen INTEGER NOT NULL, posted_at INTEGER, msg_id INTEGER)`).run();
  // added later: when a posted job was last looked up again
  const { results } = await db.prepare("PRAGMA table_info(casual)").all<{ name: string }>();
  if (!(results ?? []).some((c) => c.name === "checked_at")) await db.prepare("ALTER TABLE casual ADD COLUMN checked_at INTEGER").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS casual_status ON casual(status)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS casual_dkey ON casual(dkey)").run();
  ready.add(db);
}
interface Row { id: string; title: string; company: string; place: string; attempts: number }

// ---------------------------------------------------------------- where
export interface Where { city: string; radius: number; only: boolean }
const RADIUS: [number, number] = [5, 100];

export async function whereOf(store: Store, cfg: Config): Promise<Where> {
  const r = Number(await store.kvGet("casual_radius"));
  const only = await store.kvGet("casual_only_city");
  return {
    city: (await store.kvGet("casual_city")) || cfg.city,
    radius: r > 0 ? r : cfg.casual_jobs.radius_km,
    only: only === null ? cfg.casual_jobs.only_city : only === "1",
  };
}
/** "Kolkwitz, Niederlausitz" is not in Cottbus; "Cottbus", "Cottbus, Sandow" and "03046 Cottbus" are. */
export const inTown = (place: string, city: string) =>
  place.replace(/^\d{5}\s+/, "").split(",")[0].trim().toLowerCase() === city.trim().toLowerCase();
const outside = (w: Where, place: string) => w.only && !inTown(place, w.city);

// ---------------------------------------------------------------- one tick
export async function casualStep(env: CasualEnv, store: Store, tg: Telegram): Promise<string> {
  const cfg = await loadConfig(store);
  if (!cfg) return `casual: ${NO_CONFIG}`;
  if (!cfg.modules.casual_jobs) return "casual: off";
  if ((await store.kvGet("casual_on")) === "0") return "casual: paused";
  const db = env.DB;
  await ensureTable(db);
  const did: string[] = [];
  const w = await whereOf(store, cfg);
  await introduce(cfg, store, tg, "casual_jobs",
    `🧺 <b>Minijobs</b> ${esc(where(w))} will be posted here, with the pay and the hours.\n\n/casual - change the town or radius, or pause`);
  // kv casual_repost=<unix time>: the cards posted since then come down and go out again
  const since = Number((await store.kvGet("casual_repost")) ?? 0);
  if (since > 0) {
    await store.kvSet("casual_repost", "0");
    const { results } = await db.prepare("SELECT id, msg_id FROM casual WHERE status='posted' AND posted_at >= ?").bind(since).all<{ id: string; msg_id: number | null }>();
    for (const r of results ?? []) {
      if (r.msg_id) try { await tg.deleteMessage(r.msg_id); } catch { /* gone, or older than 48 h */ }
      await setRow(db, r.id, { status: "new", attempts: 0, msg_id: null, posted_at: null });
    }
    if (results?.length) did.push(`${results.length} taken down to re-post`);
  }
  // kv casual_recheck=1: take down posted cards the current place leaves out
  if ((await store.kvGet("casual_recheck")) === "1") {
    await store.kvSet("casual_recheck", "0");
    const gone = await takeDownOutside(db, tg, w);
    if (gone) did.push(`${gone} cards outside ${w.city} taken down`);
  }
  const src = cfg.casual_jobs.sources;
  if (now() - Number((await store.kvGet("casual_searched_at")) ?? 0) >= SEARCH_EVERY) {
    try {
      if (src.includes("minijobs")) did.push(await search(db, w, store));
      if (src.includes("part_time")) did.push(await searchPartTime(db, w, store));
      await store.kvSet("casual_searched_at", String(now()));
    } catch (e: any) { did.push(`search: ${e?.message ?? e}`); await noteError(store, "casual_ba", e); }
  }
  if (src.includes("kleinanzeigen") && now() - Number((await store.kvGet("casual_ka_at")) ?? 0) >= KA_EVERY)
    did.push(await searchKleinanzeigen(db, store, w, cfg));
  const ruled = await takeDownRuledOut(db, tg);
  if (ruled) did.push(`${ruled} taken down by a rule`);
  const gone = await recheck(db, store, tg);
  if (gone) did.push(`${gone} no longer listed`);
  const n = await post(env, store, tg, cfg, w);
  if (n) did.push(`${n} posted`);
  return `casual: ${did.join(", ") || "nothing to do"}`;
}

async function search(db: D1Database, w: Where, store?: Store): Promise<string> {
  const u = new URL(`${BA}/pc/v6/jobs`);
  const place = { wo: w.city, umkreis: String(w.radius) };
  for (const [k, v] of Object.entries({ ...place, arbeitszeit: "mj", veroeffentlichtseit: "30", size: "100" }))
    u.searchParams.set(k, v);
  const r = await fetch(u, { headers: BA_KEY });
  if (!r.ok) throw new Error(`Jobbörse ${r.status}`);
  const list = (((await r.json()) as any).ergebnisliste ?? [])
    .filter((j: any) => !["AUSBILDUNG", "SELBSTAENDIGKEIT"].includes(j.stellenangebotsart));
  if (store) await noteOk(store, "casual_ba", list.length);
  let fresh = 0, keep = 0;
  for (const j of list) {
    const id = "ba:" + j.referenznummer;
    const title = j.stellenangebotsTitel ?? "", company = j.firma ?? "";
    const place = j.stellenlokationen?.[0]?.adresse?.ort ?? "";
    const dkey = dedupeKey(company, title, place);
    const known = await db.prepare("SELECT 1 FROM casual WHERE id=? OR dkey=? LIMIT 1").bind(id, dkey).first();
    if (known) continue;
    fresh++;
    const why = outside(w, place) ? `not in ${w.city}` : casualRejectReason(title);
    if (!why) keep++;
    await db.prepare(
      `INSERT OR IGNORE INTO casual (id,dkey,title,company,place,status,why,first_seen) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, dkey, title, company, place, why ? "skipped" : "new", why, now()).run();
  }
  return `${list.length} Minijobs, ${fresh} new, ${keep} to post`;
}

/** The Jobbörse's part-time jobs of the last week, casual work only. */
async function searchPartTime(db: D1Database, w: Where, store?: Store): Promise<string> {
  const u = new URL(`${BA}/pc/v6/jobs`);
  for (const [k, v] of Object.entries({ wo: w.city, umkreis: String(w.radius), arbeitszeit: "tz", veroeffentlichtseit: "7", size: "100" }))
    u.searchParams.set(k, v);
  const r = await fetch(u, { headers: BA_KEY });
  if (!r.ok) throw new Error(`Jobbörse ${r.status}`);
  const list = (((await r.json()) as any).ergebnisliste ?? [])
    .filter((j: any) => !["AUSBILDUNG", "SELBSTAENDIGKEIT"].includes(j.stellenangebotsart));
  if (store) await noteOk(store, "casual_ba", list.length);
  let fresh = 0, keep = 0;
  for (const j of list) {
    const title = j.stellenangebotsTitel ?? "", company = j.firma ?? "";
    const place = j.stellenlokationen?.[0]?.adresse?.ort ?? "";
    const dkey = dedupeKey(company, title, place);
    // a Minijob found by the other search has the same reference number
    const known = await db.prepare("SELECT 1 FROM casual WHERE id IN (?, ?) OR dkey=? LIMIT 1")
      .bind("bt:" + j.referenznummer, "ba:" + j.referenznummer, dkey).first();
    if (known) continue;
    fresh++;
    const why = outside(w, place) ? `not in ${w.city}` : partTimeRejectReason(title);
    if (!why) keep++;
    await db.prepare(
      `INSERT OR IGNORE INTO casual (id,dkey,title,company,place,status,why,first_seen) VALUES (?,?,?,?,?,?,?,?)`)
      .bind("bt:" + j.referenznummer, dkey, title, company, place, why ? "skipped" : "new", why, now()).run();
  }
  return `${list.length} part-time, ${fresh} new, ${keep} to post`;
}

const kaJar = (store: Store): CookieJar => ({
  read: () => store.kvGet("cookies_casual"),
  write: (c: string) => store.kvSet("cookies_casual", c),
});

/** "Heute", "Gestern" or "dd.mm.yyyy", by ad id, from the listing's cards. */
function kaDates(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const blk of html.split(/<article class="[^"]*" data-adid=/).slice(1)) {
    const id = /^"(\d+)"/.exec(blk)?.[1];
    const d = /(Heute|Gestern|\d{2}\.\d{2}\.\d{4})/.exec(blk.split("</article>", 1)[0])?.[1];
    if (id && d) out.set(id, d);
  }
  return out;
}
const daysOld = (posted?: string) => {
  const m = posted && /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(posted);
  return m ? (Date.now() - Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))) / 86400_000 : 0;
};

/**
 * Kleinanzeigen's Mini- & Nebenjobs, hourly. Sits out while Kleinanzeigen is
 * limiting the room search or the finds, and for an hour after it refuses this.
 */
async function searchKleinanzeigen(db: D1Database, store: Store, w: Where, cfg?: Config): Promise<string> {
  const c = cfg ?? (await loadConfig(store))!;
  if (!c.ka) return "Kleinanzeigen: no place for the city";
  const t = now();
  if ((await blockSecondsLeft(store, "ka")) > 0 || Number((await store.kvGet("bikes_blocked_until")) ?? 0) > t
      || Number((await store.kvGet("casual_ka_blocked_until")) ?? 0) > t) return "Kleinanzeigen: waiting";
  let html: string;
  try {
    html = await get(`${KA_BASE}/s-jobs/mini-nebenjobs/${c.ka.slug}/anzeige:angebote/c107l${c.ka.id}r${w.radius}`, kaJar(store));
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    await store.kvSet("casual_ka_blocked_until", String(t + 3600));
    await store.kvSet("cookies_casual", "");
    await noteError(store, "casual_ka", e);
    return "Kleinanzeigen: refused, trying again in an hour";
  }
  await store.kvSet("casual_ka_at", String(t));
  const ads = kaParseListing(html);
  await noteOk(store, "casual_ka", ads.length);
  const dates = kaDates(html);
  let fresh = 0, keep = 0;
  for (const ad of ads) {
    const id = "kj:" + ad.url.replace(KA_BASE, "");
    const place = ad.district.split(" · ")[0];
    const dkey = dedupeKey("", ad.title, place);
    if (await db.prepare("SELECT 1 FROM casual WHERE id=? OR dkey=? LIMIT 1").bind(id, dkey).first()) continue;
    fresh++;
    const posted = dates.get(ad.ad_id.replace(/^ka-/, ""));
    const why = outside(w, place) ? `not in ${w.city}`
      : daysOld(posted) > KA_MAX_AGE_DAYS ? `old ad (${posted})` : kaJobRejectReason(ad.title);
    if (!why) keep++;
    await db.prepare(
      `INSERT OR IGNORE INTO casual (id,dkey,title,company,place,status,why,first_seen) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, dkey, ad.title, "", place, why ? "skipped" : "new", why, t).run();
  }
  return `Kleinanzeigen ${ads.length} Nebenjobs, ${fresh} new, ${keep} to post`;
}

// ---------------------------------------------------------------- worth it?
// Optional (casual_jobs.worth_it): the cheap model weighs how hard the work
// is against what it pays, and says in English what the job is (the ads are
// long German texts). Without an answer the card just goes out without them.
export type Verdict = { verdict: "worth" | "maybe" | "not"; why: string; about?: string };
const VERDICT: Record<Verdict["verdict"], string> = { worth: "✅ <b>Worth it</b>", maybe: "🤔 <b>Could be worth it</b>", not: "❌ <b>Not worth it</b>" };

const WORTH = (city: string) => `You judge casual jobs - Minijobs, part-time and side jobs - for a student in ${city} who wants to earn some money next to their studies. Decide whether applying is worth it, weighing how hard or unpleasant the work is (physical strain, early, night or weekend hours, stress, travel, needing a car or a licence) against what it pays (German minimum wage in 2026 is 13.90 €/h; no pay stated means minimum wage) and how well it fits around studying.

Return JSON only: {"verdict": "worth"|"maybe"|"not", "why": string, "about": string}
worth: fair or good pay for easy, pleasant or flexible work.
maybe: fine but with a catch - only minimum wage, odd hours, more effort than the pay suggests, or unclear.
not: hard or unpleasant for the money, impractical for a student, or a sales scheme.
why: one line under 90 characters naming the main reason, e.g. "15.33 €/h for light office cleaning, evenings" or "Night shifts lifting crates for minimum wage". Only what the ad says.
about: the job in plain English for someone who doesn't read German well, 2 short sentences under 260 characters: what you'd actually do, when and how much, and what they ask for (German level, licence, car, experience) if the ad says. No pay - it's shown already. Only what the ad says.`;

async function worthIt(env: CasualEnv, city: string, ad: { title: string; company: string; place: string; pay: string; times: string; text: string }): Promise<Verdict> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.FINDS_MODEL || "gpt-5.6-luna", response_format: { type: "json_object" },
      messages: [{ role: "system", content: WORTH(city) }, { role: "user", content:
        `Title: ${ad.title}\nEmployer: ${ad.company || "not stated"}\nPlace: ${ad.place}\nPay: ${ad.pay || "not stated"}\nTimes: ${ad.times || "not stated"}\n\n${ad.text.slice(0, 1500)}` }],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = JSON.parse((((await r.json()) as any)?.choices?.[0]?.message?.content) || "{}");
  if (!["worth", "maybe", "not"].includes(d.verdict)) throw new Error("no verdict");
  return { verdict: d.verdict, why: String(d.why ?? "").trim().slice(0, 110), about: String(d.about ?? "").trim().slice(0, 320) };
}

/** The verdict, or null when it's switched off or the AI didn't answer. */
async function verdictFor(env: CasualEnv, store: Store, tg: Telegram, cfg: Config, ad: Parameters<typeof worthIt>[2]): Promise<Verdict | null> {
  if (!cfg.casual_jobs.worth_it || !env.OPENAI_API_KEY) return null;
  try {
    const v = await worthIt(env, cfg.city, ad);
    await aiWorked(store);
    return v;
  } catch (e) {
    await aiFailed(store, tg, e);
    console.error("casual verdict failed:", (e as any)?.message ?? e);
    return null;
  }
}
const verdictBlock = (v: Verdict | null) => (v ? `${VERDICT[v.verdict]}${v.why ? `\n<i>${esc(v.why)}</i>` : ""}` : "");
/** The English summary; with it, the German text is only a short taste. */
const aboutBlock = (v: Verdict | null) => (v?.about ? `🇬🇧 ${esc(v.about)}` : "");
const germanMax = (v: Verdict | null) => (v?.about ? 300 : 600);

// ---------------------------------------------------------------- the card
const TIMES: [string, string][] = [
  ["arbeitszeitTeilzeitVormittag", "mornings"], ["arbeitszeitTeilzeitNachmittag", "afternoons"],
  ["arbeitszeitTeilzeitAbend", "evenings"], ["arbeitszeitSchichtNachtWochenende", "shifts / nights / weekends"],
  ["arbeitszeitTeilzeitFlexibel", "flexible"],
];

/** "€15/h" from the wage field, else a euro amount the text names, else "". */
export function payOf(d: any, text: string): string {
  const n = Number(d?.festgehalt);
  if (n > 0) {
    const eur = n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
    return d.verguetungsangabe === "STUNDENLOHN" || n < 60 ? `€${eur}/h` : `€${eur}/month`;
  }
  // "15 €", "15-20€", "16,50 €/h", "15 - 20 € pro Stunde"
  const m = /(?:(\d{1,4}(?:[.,]\d{1,2})?)\s?[-–]\s?)?(\d{1,4}(?:[.,]\d{1,2})?)\s?(?:€|euro\b|eur\b)(\s?(?:\/|pro|je)\s?(?:std\.?|stunde|h)\b)?/i.exec(text);
  return m ? `€${m[1] ? `${m[1]}-` : ""}${m[2]}${m[3] ? "/h" : ""} (from the ad)` : "";
}

/**
 * The description as plain text: markdown marks out, bullets as "•", and
 * from the tasks on when the ad opens with a long company intro.
 */
export function describe(html: string): string {
  let t = strip(html)
    .replace(/\*\*|__/g, "").replace(/^#+\s*/gm, "").replace(/^\s*[*\-–]\s+/gm, "• ").replace(/^[✓✔]\s*/gm, "• ");
  const tasks = /^.{0,30}(aufgaben|was (dich|sie) erwartet|deine tätigkeit|ihre tätigkeit|das machst du|wir suchen)/im.exec(t);
  if (tasks && tasks.index > 150) t = t.slice(tasks.index);
  return t.trim();
}

/** The description's first ~600 characters, cut at a line or sentence end. */
const short = (text: string, max = 600) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return (end > max / 2 ? cut.slice(0, end + 1) : cut).trim() + " …";
};

/** A Kleinanzeigen job: the ad's own text, the pay it names. */
export function kaJobCard(row: Row, raw: string, v: Verdict | null = null): string {
  // the posting services' decoration: lines of ➖ or ━
  const text = raw.split("\n").filter((l) => !/^[\s➖━─—=_*~.-]{3,}$/u.test(l)).join("\n");
  const pay = payOf({}, `${row.title}\n${text}`);
  return [
    `🧺 <b>${esc(row.title)}</b>\nKleinanzeigen${row.place ? ` · ${esc(row.place)}` : ""}`,
    verdictBlock(v),
    pay ? `💶 ${pay}` : "💶 pay not stated (at least minimum wage)",
    aboutBlock(v),
    text ? esc(short(text, germanMax(v))) : "",
    `<a href="${esc(KA_BASE + row.id.slice(3))}">open on Kleinanzeigen</a>`,
  ].filter(Boolean).join("\n\n");
}

export function casualCard(row: Row, d: any, v: Verdict | null = null): string {
  const text = describe(d?.stellenangebotsBeschreibung ?? "");
  const pay = payOf(d, text);
  const times = TIMES.filter(([k]) => d?.[k]).map(([, v]) => v);
  // a start date that has passed just means "now"
  const start = d?.eintrittszeitraum?.von > new Date(Date.now()).toISOString().slice(0, 10) ? d.eintrittszeitraum.von : "";
  const facts = [
    pay ? `💶 ${pay}` : "💶 pay not stated (at least minimum wage)",
    times.length ? `🕐 ${times.join(" · ")}` : "",
    start ? `📅 from ${date(start)}` : "",
    row.id.startsWith("bt:") ? "⏱ part-time - check the hours" : "",
  ].filter(Boolean).join("\n");
  const url = `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(row.id.slice(3))}`;
  return [
    `🧺 <b>${esc(row.title)}</b>\n${esc(row.company)}${row.place ? ` · ${esc(row.place)}` : ""}`,
    verdictBlock(v),
    facts,
    aboutBlock(v),
    text ? esc(short(text, germanMax(v))) : "",
    `<a href="${esc(url)}">open the job</a>` + (d?.externeURL ? ` · <a href="${esc(d.externeURL)}">apply</a>` : ""),
  ].filter(Boolean).join("\n\n");
}

async function post(env: CasualEnv, store: Store, tg: Telegram, cfg: Config, w: Where): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare(
    "SELECT * FROM casual WHERE status='new' ORDER BY first_seen, rowid LIMIT ?").bind(POST_PER_TICK).all<Row>();
  let n = 0;
  for (const row of results ?? []) {
    // the place was narrowed since it was found
    if (outside(w, row.place)) { await setRow(db, row.id, { status: "skipped", why: `not in ${w.city}` }); continue; }
    if (row.id.startsWith("kj:")) {
      // a Kleinanzeigen ad: its own page; a refusal leaves the rest for later
      try {
        const html = await get(KA_BASE + row.id.slice(3), kaJar(store));
        const [text] = kaParseAd(html);
        if (!text && html.includes("data-adid=")) { await setRow(db, row.id, { status: "skipped", why: "gone" }); continue; }
        const v = await verdictFor(env, store, tg, cfg, { title: row.title, company: "", place: row.place, pay: payOf({}, `${row.title}\n${text}`), times: "", text });
        const sent = await tg.send(kaJobCard(row, text, v), inTopic(await topicOf(cfg, store, tg, "casual_jobs")));
        await setRow(db, row.id, { status: "posted", posted_at: now(), msg_id: sent?.result?.message_id ?? null, pay: payOf({}, `${row.title}\n${text}`) || null });
        n++;
      } catch (e: any) {
        if (e instanceof Blocked) { await store.kvSet("casual_ka_blocked_until", String(now() + 3600)); continue; }
        if (String(e?.message).includes(" 429")) break;
        const tries = row.attempts + 1;
        await setRow(db, row.id, tries >= MAX_ATTEMPTS ? { attempts: tries, status: "skipped", why: `could not post: ${String(e?.message ?? e).slice(0, 100)}` } : { attempts: tries });
      }
      continue;
    }
    try {
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(row.id.slice(3))));
      const r = await fetch(`${BA}/pc/v4/jobdetails/${b64}`, { headers: BA_KEY });
      if (r.status === 404) { await setRow(db, row.id, { status: "skipped", why: "gone" }); continue; }
      if (!r.ok) throw new Error(`Jobbörse details ${r.status}`);
      const d: any = await r.json();
      const text = describe(d?.stellenangebotsBeschreibung ?? "");
      const v = await verdictFor(env, store, tg, cfg, { title: row.title, company: row.company, place: row.place,
        pay: payOf(d, text), times: TIMES.filter(([k]) => d?.[k]).map(([, x]) => x).join(", ") + (row.id.startsWith("bt:") ? " (part-time)" : ""), text });
      const sent = await tg.send(casualCard(row, d, v), inTopic(await topicOf(cfg, store, tg, "casual_jobs")));
      await setRow(db, row.id, { status: "posted", posted_at: now(), msg_id: sent?.result?.message_id ?? null,
        pay: payOf(d, describe((d as any)?.stellenangebotsBeschreibung ?? "")) || null });
      n++;
    } catch (e: any) {
      if (String(e?.message).includes(" 429")) break;
      const tries = row.attempts + 1;
      await setRow(db, row.id, tries >= MAX_ATTEMPTS ? { attempts: tries, status: "skipped", why: `could not post: ${String(e?.message ?? e).slice(0, 100)}` } : { attempts: tries });
    }
  }
  return n;
}

const setRow = (db: D1Database, id: string, f: Record<string, unknown>) => {
  const keys = Object.keys(f);
  return db.prepare(`UPDATE casual SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`)
    .bind(...keys.map((k) => f[k]), id).run();
};

/**
 * Without AI: a posted job is looked up again 3 days after it went out, then
 * every 3 days, two per tick. Gone from the Jobbörse (404) or Kleinanzeigen
 * (a deleted ad sends you to a search page): the card says so and the job no
 * longer counts as posted.
 */
const RECHECK_AFTER = 3 * 86400;
async function recheck(db: D1Database, store: Store, tg: Telegram): Promise<number> {
  const t = now();
  const { results } = await db.prepare(
    `SELECT id, title, company, place, msg_id FROM casual WHERE status='posted' AND posted_at < ? AND COALESCE(checked_at, 0) < ?
     ORDER BY COALESCE(checked_at, posted_at) LIMIT 2`).bind(t - RECHECK_AFTER, t - RECHECK_AFTER)
    .all<{ id: string; title: string; company: string; place: string; msg_id: number | null }>();
  let gone = 0;
  for (const r of results ?? []) {
    let isGone: boolean | null = null;
    try {
      if (r.id.startsWith("kj:")) {
        const html = await get(KA_BASE + r.id.slice(3), kaJar(store));
        isGone = !kaParseAd(html)[0] && html.includes("data-adid=");
      } else {
        const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(r.id.slice(3))));
        const s = (await fetch(`${BA}/pc/v4/jobdetails/${b64}`, { headers: BA_KEY })).status;
        isGone = s === 404 || s === 410 ? true : s === 200 ? false : null;
      }
    } catch (e) {
      if (e instanceof Blocked) break;                 // Kleinanzeigen is limiting: later
    }
    if (isGone === null) continue;
    if (!isGone) { await setRow(db, r.id, { checked_at: t }); continue; }
    await setRow(db, r.id, { status: "gone", checked_at: t });
    if (r.msg_id) try {
      await tg.editText(tg.chat, r.msg_id, `🚫 <b>No longer listed</b>\n<s>${esc(r.title)}</s>\n${esc([r.company, r.place].filter(Boolean).join(" · "))}`);
    } catch { /* too old, or deleted */ }
    gone++;
  }
  return gone;
}

/**
 * Posted cards a title rule now leaves out (one added after they went out,
 * like lead roles): the message is deleted and the job skipped. No fetching.
 */
async function takeDownRuledOut(db: D1Database, tg: Telegram): Promise<number> {
  const { results } = await db.prepare("SELECT id, title, msg_id FROM casual WHERE status='posted'")
    .all<{ id: string; title: string; msg_id: number | null }>();
  let n = 0;
  for (const r of results ?? []) {
    const why = r.id.startsWith("bt:") ? partTimeRejectReason(r.title) : r.id.startsWith("kj:") ? kaJobRejectReason(r.title) : casualRejectReason(r.title);
    if (!why) continue;
    if (r.msg_id) try { await tg.deleteMessage(r.msg_id); } catch { /* already gone, or older than 48 h */ }
    await setRow(db, r.id, { status: "skipped", why, msg_id: null });
    n++;
  }
  return n;
}

/** Posted cards from outside the city, when only the city itself counts: deleted. */
async function takeDownOutside(db: D1Database, tg: Telegram, w: Where): Promise<number> {
  if (!w.only) return 0;
  await ensureTable(db);
  const { results } = await db.prepare("SELECT id, place, msg_id FROM casual WHERE status='posted'")
    .all<{ id: string; place: string; msg_id: number | null }>();
  let n = 0;
  for (const r of results ?? []) {
    if (inTown(r.place ?? "", w.city)) continue;
    if (r.msg_id) try { await tg.deleteMessage(r.msg_id); } catch { /* already gone, or older than 48 h */ }
    await setRow(db, r.id, { status: "skipped", why: `not in ${w.city}`, msg_id: null });
    n++;
  }
  return n;
}

/** "within 25 km of Cottbus", "in Cottbus only" */
const where = (w: Where) => (w.only ? `in ${w.city} only` : `within ${w.radius} km of ${w.city}`);

/** One line for /status. */
export async function casualLine(store: Store, db: D1Database): Promise<string> {
  if ((await store.kvGet("casual_on")) === "0") return "Casual jobs:     ⏸ paused";
  await ensureTable(db);
  const r = await db.prepare("SELECT SUM(status='posted') posted, SUM(status='new') waiting FROM casual")
    .first<{ posted: number | null; waiting: number | null }>();
  const at = Number((await store.kvGet("casual_searched_at")) ?? 0);
  const cfg = await loadConfig(store);
  const place = cfg ? ` ${where(await whereOf(store, cfg))}` : "";
  return `Casual jobs:     ✅ ${r?.posted ?? 0} posted${place}` + (r?.waiting ? `, ${r.waiting} to come` : "") +
    (at ? `, checked ${fmtLeft(Math.max(0, now() - at))} ago` : "");
}

// ---------------------------------------------------------------- /casual
/** The /casual card: where it looks, and buttons to change it. */
export async function casualSettings(store: Store, cfg: Config): Promise<[string, Button[][]]> {
  const w = await whereOf(store, cfg);
  const on = (await store.kvGet("casual_on")) !== "0";
  const text = [
    `🧺 <b>Minijobs</b> ${esc(where(w))}${on ? "" : " - ⏸ paused"}`,
    "",
    `Searched: ${esc(w.city)}, ${w.radius} km around`,
    `Only ${esc(w.city)} itself: ${w.only ? "yes, the towns around it are left out" : "no, the towns around it too"}`,
    "",
    `<i>/casual 10 · /casual city Spremberg · /casual only on|off · /casual off · /casual now - anyone here can change it</i>`,
  ].join("\n");
  const kb: Button[][] = [
    [{ text: "−5 km", callback_data: "cj:radius:-5" }, { text: `${w.radius} km`, callback_data: "cj:noop" },
     { text: "+5 km", callback_data: "cj:radius:+5" }],
    [{ text: `${w.only ? "✅" : "⬜"} only ${w.city} itself`, callback_data: `cj:only:${w.only ? "off" : "on"}` }],
    [{ text: on ? "⏸ Pause" : "▶️ Resume", callback_data: `cj:${on ? "off" : "on"}` },
     { text: "🔄 Check now", callback_data: "cj:now" }],
  ];
  return [text, kb];
}

/**
 * A change from /casual or its buttons: radius ±n or n, city, only on/off,
 * on/off. The answer to show; "only on" also takes down the cards from
 * outside the city.
 */
export async function setCasual(db: D1Database, store: Store, tg: Telegram, cfg: Config, what: string, value = ""): Promise<string> {
  const w = await whereOf(store, cfg);
  const fresh = () => store.kvSet("casual_searched_at", "0");     // look again on the next tick
  if (what === "radius") {
    const v = Math.round(/^[+-]/.test(value) ? w.radius + Number(value) : Number(value));
    if (!Number.isFinite(v) || !value) return "Try /casual 10 (km)";
    const r = Math.min(RADIUS[1], Math.max(RADIUS[0], v));
    await store.kvSet("casual_radius", String(r)); await fresh();
    return `🧺 Minijobs: ${r} km around ${w.city}`;
  }
  if (what === "city") {
    const city = value.trim();
    if (!city) return "Try /casual city Spremberg";
    await store.kvSet("casual_city", city === cfg.city ? "" : city); await fresh();
    return `🧺 Minijobs: around ${city} from the next check`;
  }
  if (what === "only") {
    const only = value === "on";
    await store.kvSet("casual_only_city", only ? "1" : "0");
    if (!only) return `🧺 Minijobs: ${w.city} and the towns around it`;
    const gone = await takeDownOutside(db, tg, { ...w, only: true });
    return `🧺 Minijobs: only ${w.city} itself` + (gone ? ` - took down ${gone} card${gone === 1 ? "" : "s"} from other towns` : "");
  }
  if (what === "on" || what === "off") {
    await store.kvSet("casual_on", what === "on" ? "1" : "0");
    return `🧺 Minijobs: ${what === "on" ? "on" : "paused"}`;
  }
  return "";
}
