// Casual jobs - Minijobs around the config's city (Aushilfe, Verkauf,
// Reinigung, Zeitung austragen, Küchenhilfe, …) - posted to their own topic.
// No AI and no buttons: each card is the job, the pay, the hours and the
// description.
//
// Source: the Jobbörse's Minijob filter, every 30 minutes. Its details give
// the hourly wage when the employer filled it in (about one ad in five) and
// which times of day the job is for. Titles that need a trade or a licence
// (Pflegefachkraft, Erzieher, Berufskraftfahrer, …) are left out by a word list.
//
// Where: the config's city and radius, or what /casual set since (kv
// casual_city, casual_radius, casual_only_city - they win over the config).
// "Only the city itself" drops the towns around it, and switching it on
// takes down the cards already posted from them.

import { loadConfig, NO_CONFIG, type Config } from "./config.ts";
import { strip } from "./jobs.ts";
import { fmtLeft } from "./settings.ts";
import type { Store } from "./store.ts";
import { esc, inTopic, type Button, type Telegram } from "./telegram.ts";
import { topicOf } from "./topics.ts";

export const CASUAL_CRON = "7,17,27,37,47,57 * * * *";
const SEARCH_EVERY = 30 * 60;
const POST_PER_TICK = 5;
const MAX_ATTEMPTS = 3;

const BA = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service";
const BA_KEY = { "X-API-Key": "jobboerse-jobsuche" };   // the Jobbörse's public client key

export interface CasualEnv { DB: D1Database }

const now = () => Math.floor(Date.now() / 1000);
const date = (iso?: string) => (iso ? iso.slice(0, 10).split("-").reverse().slice(0, 2).join(".") + "." : "");

// ---------------------------------------------------------------- rules
// needs a qualification or a licence nobody gets on the side
const QUALIFIED = /fachkraft|pflegekraft|pflegefach|altenpfleg|krankenpfleg|therapeut|physio|logopäd|erzieher|lehrer|ausbilder|dozent|arzt|ärzt|apothek|hebamme|sozialpäd|psycholog|berufskraftfahrer|\blkw\b|bus ?fahrer|baumaschin|kranführer|elektri|mechani|mechatron|(?<!haus)meister|ingenieur|steuerfach|buchhalt|bilanz|medizinische|zahnmed|nageldesign|wimpern|kosmetik|friseur|anwalt|jurist/;
const FULL_TIME = /vollzeit|full[- ]?time/;
const CASUAL = /mini-?job|aushilf|teilzeit|nebenjob|werkstudent/;

/** Why a casual job is left out, by its title, or null. */
export function casualRejectReason(title: string): string | null {
  const t = title.toLowerCase();
  if (QUALIFIED.test(t)) return "needs a qualification";
  if (/\b(ausbildung|azubi|duales studium)\b/.test(t)) return "apprenticeship";
  if (FULL_TIME.test(t) && !CASUAL.test(t)) return "full-time";
  return null;
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
/** "Kolkwitz, Niederlausitz" is not in Cottbus; "Cottbus" and "Cottbus, Sandow" are. */
export const inTown = (place: string, city: string) =>
  place.split(",")[0].trim().toLowerCase() === city.trim().toLowerCase();
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
  // kv casual_recheck=1: take down posted cards the current place leaves out
  if ((await store.kvGet("casual_recheck")) === "1") {
    await store.kvSet("casual_recheck", "0");
    const gone = await takeDownOutside(db, tg, w);
    if (gone) did.push(`${gone} cards outside ${w.city} taken down`);
  }
  if (now() - Number((await store.kvGet("casual_searched_at")) ?? 0) >= SEARCH_EVERY) {
    try { did.push(await search(db, w)); await store.kvSet("casual_searched_at", String(now())); }
    catch (e: any) { did.push(`search: ${e?.message ?? e}`); }
  }
  const n = await post(env, store, tg, cfg, w);
  if (n) did.push(`${n} posted`);
  return `casual: ${did.join(", ") || "nothing to do"}`;
}

async function search(db: D1Database, w: Where): Promise<string> {
  const u = new URL(`${BA}/pc/v6/jobs`);
  const place = { wo: w.city, umkreis: String(w.radius) };
  for (const [k, v] of Object.entries({ ...place, arbeitszeit: "mj", veroeffentlichtseit: "30", size: "100" }))
    u.searchParams.set(k, v);
  const r = await fetch(u, { headers: BA_KEY });
  if (!r.ok) throw new Error(`Jobbörse ${r.status}`);
  const list = (((await r.json()) as any).ergebnisliste ?? [])
    .filter((j: any) => !["AUSBILDUNG", "SELBSTAENDIGKEIT"].includes(j.stellenangebotsart));
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
  const m = /(\d{1,4}(?:[.,]\d{1,2})?)\s?(?:€|euro\b|eur\b)(\s?(?:\/|pro|je)\s?(?:std\.?|stunde|h)\b)?/i.exec(text);
  return m ? `€${m[1]}${m[2] ? "/h" : ""} (from the ad)` : "";
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

export function casualCard(row: Row, d: any): string {
  const text = describe(d?.stellenangebotsBeschreibung ?? "");
  const pay = payOf(d, text);
  const times = TIMES.filter(([k]) => d?.[k]).map(([, v]) => v);
  // a start date that has passed just means "now"
  const start = d?.eintrittszeitraum?.von > new Date(Date.now()).toISOString().slice(0, 10) ? d.eintrittszeitraum.von : "";
  const facts = [
    pay ? `💶 ${pay}` : "💶 pay not stated (at least minimum wage)",
    times.length ? `🕐 ${times.join(" · ")}` : "",
    start ? `📅 from ${date(start)}` : "",
  ].filter(Boolean).join("\n");
  const url = `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(row.id.slice(3))}`;
  return [
    `🧺 <b>${esc(row.title)}</b>\n${esc(row.company)}${row.place ? ` · ${esc(row.place)}` : ""}`,
    facts,
    text ? esc(short(text)) : "",
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
    try {
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(row.id.slice(3))));
      const r = await fetch(`${BA}/pc/v4/jobdetails/${b64}`, { headers: BA_KEY });
      if (r.status === 404) { await setRow(db, row.id, { status: "skipped", why: "gone" }); continue; }
      if (!r.ok) throw new Error(`Jobbörse details ${r.status}`);
      const d = await r.json();
      const sent = await tg.send(casualCard(row, d), inTopic(await topicOf(cfg, store, tg, "casual_jobs")));
      await setRow(db, row.id, { status: "posted", posted_at: now(), msg_id: sent?.result?.message_id ?? null,
        pay: payOf(d, describe((d as any)?.stellenangebotsBeschreibung ?? "")) || null });
      n++;
    } catch (e: any) {
      if (String(e?.message).includes(" 429")) break;
      const tries = row.attempts + 1;
      await setRow(db, row.id, tries >= MAX_ATTEMPTS ? { attempts: tries, status: "skipped", why: "could not post" } : { attempts: tries });
    }
  }
  return n;
}

const setRow = (db: D1Database, id: string, f: Record<string, unknown>) => {
  const keys = Object.keys(f);
  return db.prepare(`UPDATE casual SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`)
    .bind(...keys.map((k) => f[k]), id).run();
};

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
