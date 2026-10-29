// Casual jobs - Minijobs around Cottbus (Aushilfe, Verkauf, Reinigung,
// Zeitung austragen, Küchenhilfe, …) - posted to their own topic. No AI and
// no buttons: each card is the job, the pay, the hours and the description.
//
// Source: the Jobbörse's Minijob filter, every 30 minutes. Its details give
// the hourly wage when the employer filled it in (about one ad in five) and
// which times of day the job is for. Titles that need a trade or a licence
// (Pflegefachkraft, Erzieher, Berufskraftfahrer, …) are left out by a word list.

import { strip } from "./jobs.ts";
import { fmtLeft } from "./settings.ts";
import type { Store } from "./store.ts";
import { esc, inTopic, type Telegram } from "./telegram.ts";

export const CASUAL_CRON = "7,17,27,37,47,57 * * * *";
const SEARCH_EVERY = 30 * 60;
const POST_PER_TICK = 5;
const MAX_ATTEMPTS = 3;
const PLACE = { wo: "Cottbus", umkreis: "25" };

const BA = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service";
const BA_KEY = { "X-API-Key": "jobboerse-jobsuche" };   // the Jobbörse's public client key

export interface CasualEnv { DB: D1Database; TOPIC_CASUAL?: string }

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

// ---------------------------------------------------------------- one tick
export async function casualStep(env: CasualEnv, store: Store, tg: Telegram): Promise<string> {
  if ((await store.kvGet("casual_on")) === "0") return "casual: paused";
  const db = env.DB;
  await ensureTable(db);
  const did: string[] = [];
  if (now() - Number((await store.kvGet("casual_searched_at")) ?? 0) >= SEARCH_EVERY) {
    try { did.push(await search(db)); await store.kvSet("casual_searched_at", String(now())); }
    catch (e: any) { did.push(`search: ${e?.message ?? e}`); }
  }
  const n = await post(env, tg);
  if (n) did.push(`${n} posted`);
  return `casual: ${did.join(", ") || "nothing to do"}`;
}

async function search(db: D1Database): Promise<string> {
  const u = new URL(`${BA}/pc/v6/jobs`);
  for (const [k, v] of Object.entries({ ...PLACE, arbeitszeit: "mj", veroeffentlichtseit: "30", size: "100" }))
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
    const why = casualRejectReason(title);
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

async function post(env: CasualEnv, tg: Telegram): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare(
    "SELECT * FROM casual WHERE status='new' ORDER BY first_seen, rowid LIMIT ?").bind(POST_PER_TICK).all<Row>();
  let n = 0;
  for (const row of results ?? []) {
    try {
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(row.id.slice(3))));
      const r = await fetch(`${BA}/pc/v4/jobdetails/${b64}`, { headers: BA_KEY });
      if (r.status === 404) { await setRow(db, row.id, { status: "skipped", why: "gone" }); continue; }
      if (!r.ok) throw new Error(`Jobbörse details ${r.status}`);
      const d = await r.json();
      const sent = await tg.send(casualCard(row, d), inTopic(Number(env.TOPIC_CASUAL) || null));
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

/** One line for /status. */
export async function casualLine(store: Store, db: D1Database): Promise<string> {
  if ((await store.kvGet("casual_on")) === "0") return "Casual jobs:     ⏸ paused";
  await ensureTable(db);
  const r = await db.prepare("SELECT SUM(status='posted') posted, SUM(status='new') waiting FROM casual")
    .first<{ posted: number | null; waiting: number | null }>();
  const at = Number((await store.kvGet("casual_searched_at")) ?? 0);
  return `Casual jobs:     ✅ ${r?.posted ?? 0} posted` + (r?.waiting ? `, ${r.waiting} to come` : "") +
    (at ? `, checked ${fmtLeft(Math.max(0, now() - at))} ago` : "");
}
