// Events, in two topics: cultural events (theatre, concerts, exhibitions)
// and career events (meetups, hackathons, the university's career and
// scholarship notices). No AI: each event is a card with when, where, the
// price and a link, posted when it's found.
//
// Sources, read on a trigger of their own (one source per tick, each about
// every 6 hours - events change slowly):
//   culture: cottbus_theater (Staatstheater Cottbus' programme), gladhouse
//            (Glad-House Cottbus), cottbus_city (cottbus.de's events)
//   career:  devpost (hackathons, online or in Germany), meetup (the
//            groups' calendar feeds), btu (BTU's notices: career,
//            scholarships, info days)
// The theatre and city readers are for Cottbus; other cities use meetup
// groups and devpost, or add a reader here.
//
// Cultural events over the budget (10 € by default) are left out; ones
// without a listed price say so. A show on several dates is posted once.
// Only events in the next few weeks go out; past ones never do. A card with
// the event's poster goes out as a photo (the theatre's, from the show's own
// page when it's posted); without one, as text.

import { loadConfig, NO_CONFIG, type Config } from "./config.ts";
import type { Store } from "./store.ts";
import { esc, inTopic, type Button, type Telegram } from "./telegram.ts";
import { introduce, topicOf } from "./topics.ts";
import { noteError, noteOk } from "./watch.ts";

export const EVENTS_CRON = "1,11,21,31,41,51 * * * *";
const POST_PER_TICK = 4;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const now = () => Math.floor(Date.now() / 1000);

export type Kind = "culture" | "career";
export interface Event {
  id: string;            // "<source>:<its own id>"
  kind: Kind;
  title: string;
  starts: string;        // "2026-11-17" or "2026-11-17T16:00"
  ends?: string;         // last day, for a run (an exhibition, a hackathon)
  place: string;
  price: number | null;  // € (0 = free), null = not listed
  url: string;
  tickets?: string;
  note: string;          // a line or two about it
  tag: string;           // "Musiktheater", "Konzert", "Hackathon"…
  image?: string;        // the poster, when the source has one
}

// ---------------------------------------------------------------- reading the sources
const unent = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
const text = (html: string) => unent(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const one = (rx: RegExp, s: string) => rx.exec(s)?.[1] ?? "";
// "19:00" or "19:00 Uhr" - never "7.11.", which is a date
const hhmm = (s: string) => { const m = /\b(\d{1,2}):(\d{2})\b/.exec(s); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : ""; };

/** "free" words, or a euro amount: 0, the lowest amount, or null. */
export function priceOf(s: string): number | null {
  const t = s.toLowerCase();
  if (/eintritt (frei|kostenlos)|freier eintritt|kostenfrei|kostenlos|gratis|\bfree\b|offene probe|spende/.test(t)) return 0;
  const amounts = [...t.matchAll(/(\d{1,3}(?:[.,]\d{1,2})?)\s?(?:€|euro\b|eur\b)/g)].map((m) => Number(m[1].replace(",", ".")));
  return amounts.length ? Math.min(...amounts) : null;
}

/** Staatstheater Cottbus: day blocks, each with its performances. */
export function parseTheater(html: string, base = "https://www.staatstheater-cottbus.de"): Event[] {
  const out: Event[] = [];
  for (const day of html.split('<div class="calender-line">').slice(1)) {
    const date = one(/class="hidden fulldate">(\d{4}-\d{2}-\d{2})</, day);
    if (!date) continue;
    for (const ev of day.split('<div id="article_').slice(1)) {
      const title = text(one(/<h3 class="title[^"]*"><span>([\s\S]*?)<\/span>/, ev));
      if (!title) continue;
      const path = one(/<a href="([^"]+)" class="headline"/, ev);
      const time = hhmm(text(one(/class="event-time">([\s\S]*?)<\/span>/, ev)));
      const hint = text(one(/class="event-hinweis[^"]*">([\s\S]*?)<\/div>\s*<\/div>/, ev));
      const sub = text(one(/<div class="subtitle"><span>([\s\S]*?)<\/span><\/div>/, ev));
      out.push({
        id: `theater:${one(/^([^"]+)"/, ev)}`, kind: "culture", title, starts: time ? `${date}T${time}` : date,
        place: `${text(one(/class="event-location">(?:<span[^>]*>)?([\s\S]*?)<\/span>/, ev)) || "Staatstheater"} (Staatstheater Cottbus)`,
        price: priceOf(`${title} ${hint}`), url: path.startsWith("http") ? path : base + path,
        tickets: one(/class="event-tickets[^"]*" href="([^"]+)"/, ev).replace(/&amp;/g, "&") || undefined,
        note: [sub, hint].filter(Boolean).join(" · ").slice(0, 240), tag: text(one(/class="event-divisions">([\s\S]*?)<\/li>/, ev)),
      });
    }
  }
  return out;
}

/**
 * Glad-House: a "dd.mm.yyyy | hh:mm Uhr" line, then the title, then a text
 * with the price. The poster is the image just before the date.
 */
export function parseGladhouse(html: string): Event[] {
  const out: Event[] = [];
  const at = [...html.matchAll(/<strong>\s*(?=\d{2}\.\d{2}\.\d{4})/g)].map((m) => m.index!);
  const parts = html.split(/<strong>\s*(?=\d{2}\.\d{2}\.\d{4})/).slice(1);
  parts.forEach((p, n) => {
    const before = html.slice(Math.max(n ? at[n - 1] + 40 : 0, at[n] - 4000), at[n]);
    const posters = [...before.matchAll(/src="(https:\/\/image\.jimcdn\.com\/[^"]+)"/g)];
    // the page shows it 249 px wide; Jimdo serves any size, so ask for a readable one
    const image = posters.length
      ? posters[posters.length - 1][1].replace(/dimension=\d+x\d+:format=\w+/, "dimension=1000x10000:format=jpg") : undefined;
    const m = /^(\d{2})\.(\d{2})\.(\d{4})\s*(?:\|\s*(\d{1,2}[:.]\d{2}))?/.exec(p);
    if (!m) return;
    const title = text(one(/<h3[^>]*>([\s\S]*?)<\/h3>/, p.slice(0, 3000)));
    if (!title) return;
    const body = text(p.slice(p.indexOf("</h3>") + 5, p.indexOf("</h3>") + 2500)).slice(0, 600);
    const date = `${m[3]}-${m[2]}-${m[1]}`;
    out.push({
      id: `gladhouse:${date}:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`, kind: "culture", title,
      starts: m[4] ? `${date}T${hhmm(m[4])}` : date, place: "Glad-House Cottbus", price: priceOf(body),
      url: "https://www.gladhouse.de/", note: body.slice(0, 240), tag: "", image,
    });
  });
  return out;
}

/** cottbus.de: one card per event, cut out cheaply (the page is large). */
export function parseCottbus(html: string): Event[] {
  const out: Event[] = [];
  for (const card of html.split('<article class="prec-event-card"').slice(1)) {
    const c = card.slice(0, card.indexOf("</article>"));
    const title = text(one(/<h3 class="prec-event-title">([\s\S]*?)<\/h3>/, c));
    const start = one(/<time datetime="(\d{4}-\d{2}-\d{2})/, c);
    if (!title || !start) continue;
    const metas = [...c.matchAll(/<div class="prec-event-meta-row">([\s\S]*?)<\/div>/g)].map((m) => text(m[1]));
    const time = metas.map(hhmm).find(Boolean) ?? "";
    const place = metas.find((x) => x && !/\d{1,2}:\d{2}|\d{1,2}\.\s?\d{1,2}\.|\d{1,2}\.\s?\w+\.? \d{4}/.test(x)) ?? "";
    const note = text(one(/class="prec-event-excerpt">([\s\S]*?)<\/p>/, c)).slice(0, 240);
    const endDay = one(/class="prec-badge-end"[^>]*>→\s*(\d{1,2})\./, c);
    out.push({
      id: `cottbus:${one(/id="prec-event-(\d+)"/, c)}`, kind: "culture", title, starts: time ? `${start}T${time}` : start,
      ends: endDay ? `${start.slice(0, 8)}${endDay.padStart(2, "0")}` : undefined, place: place || "Cottbus",
      price: priceOf(`${metas.join(" ")} ${note}`), url: one(/data-href="([^"]+)"/, c), note,
      tag: text(one(/class="prec-event-category-tag">([\s\S]*?)<\/span>/, c)),
      image: one(/class="prec-event-thumb">[\s\S]*?<img[^>]+src="([^"]+)"/, c) || undefined,
    });
  }
  return out;
}

/** Devpost's hackathon list (JSON): online ones, and ones in Germany. */
export function parseDevpost(json: any): Event[] {
  const months: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const out: Event[] = [];
  for (const h of json?.hackathons ?? []) {
    const where = String(h?.displayed_location?.location ?? "");
    if (!/online|germany|deutschland|berlin|cottbus|dresden|leipzig|potsdam/i.test(where)) continue;
    // "Nov 08 - 15, 2026", "Dec 19, 2026 - Jan 18, 2027", "Nov 15, 2026"
    const d = String(h?.submission_period_dates ?? "");
    const m = /^([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?/.exec(d);
    const year = /(\d{4})/.exec(d)?.[1];
    if (!m || !year) continue;
    const start = `${m[3] ?? year}-${months[m[1].toLowerCase()]}-${m[2].padStart(2, "0")}`;
    const e = /(?:([A-Z][a-z]{2}) )?(\d{1,2}), (\d{4})$/.exec(d);
    const end = e ? `${e[3]}-${months[(e[1] ?? m[1]).toLowerCase()]}-${e[2].padStart(2, "0")}` : undefined;
    const prize = text(String(h?.prize_amount ?? "")).replace(/\s/g, "");
    out.push({
      id: `devpost:${h.id}`, kind: "career", title: String(h.title ?? "").slice(0, 200), starts: start, ends: end, place: where,
      price: 0, url: String(h.url ?? ""), tag: "Hackathon",
      image: h.thumbnail_url ? String(h.thumbnail_url).replace(/^\/\//, "https://") : undefined,
      note: [prize && prize !== "$0" ? `prizes ${prize}` : "", (h.themes ?? []).map((t: any) => t.name).slice(0, 3).join(", ")].filter(Boolean).join(" · "),
    });
  }
  return out;
}

/** A Meetup group's calendar feed (iCal): its upcoming events. */
export function parseIcal(ics: string, source: string): Event[] {
  const unfold = ics.replace(/\r?\n[ \t]/g, "");
  return unfold.split("BEGIN:VEVENT").slice(1).map((v) => {
    const f = (k: string) => (new RegExp(`^${k}(?:;[^:\\n]*)?:(.*)$`, "m").exec(v)?.[1] ?? "").replace(/\\,/g, ",").replace(/\\n/g, " ").replace(/\\;/g, ";").trim();
    const d = /(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/.exec(f("DTSTART"));
    const starts = d ? `${d[1]}-${d[2]}-${d[3]}${d[4] ? `T${d[4]}:${d[5]}` : ""}` : "";
    return { id: `${source}:${f("UID").slice(0, 80)}`, kind: "career" as Kind, title: f("SUMMARY"), starts, place: f("LOCATION") || "online",
      price: priceOf(f("DESCRIPTION")) ?? 0, url: f("URL"), note: f("DESCRIPTION").slice(0, 240), tag: "Meetup" };
  }).filter((e) => e.title && e.starts);
}

/** BTU's start page notices; only the ones about careers, scholarships and info days. */
export function parseBtu(html: string): Event[] {
  const out: Event[] = [];
  const CAREER = /karriere|career|stipend|scholarship|job|messe|bewerb|workshop|infoveranstaltung|info day|transfertag|gründ|praktik|alumni|speak europe|sprach/i;
  for (const m of html.matchAll(/<h2>\s*([\s\S]*?)<small>([\s\S]*?)<\/small><\/h2><a href="([^"]+)"/g)) {
    const title = text(m[1]), sub = text(m[2]);
    // the slide's own picture comes just before its text
    const pics = [...html.slice(Math.max(0, m.index! - 1500), m.index!).matchAll(/data-original="([^"]+)"/g)];
    const pic = pics.length ? pics[pics.length - 1][1] : "";
    if (!CAREER.test(`${title} ${sub}`)) continue;
    // "Bis zum 15. November 2026 bewerben!" - a deadline is the date that matters
    const dm = /(\d{1,2})\.\s?(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s(\d{4})/.exec(sub);
    const MON = ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];
    const starts = dm ? `${dm[3]}-${String(MON.indexOf(dm[2].toLowerCase()) + 1).padStart(2, "0")}-${dm[1].padStart(2, "0")}` : "";
    out.push({ id: `btu:${m[3].replace(/^https?:\/\/[^/]+/, "").slice(0, 120)}`, kind: "career", title, starts, place: "BTU Cottbus-Senftenberg",
      price: 0, url: m[3].startsWith("http") ? m[3] : `https://www.b-tu.de${m[3]}`, note: sub, tag: /stipend|scholarship/i.test(title) ? "Scholarship" : "BTU",
      image: pic ? (pic.startsWith("http") ? pic : `https://www.b-tu.de${pic}`) : undefined });
  }
  return out;
}

// ---------------------------------------------------------------- sources
interface Source { kind: Kind; every: number; url: (cfg: Config) => string[]; parse: (body: string, src: string) => Event[] }
const H = 3600;
export const SOURCES: Record<string, Source> = {
  cottbus_theater: { kind: "culture", every: 6 * H, url: () => ["https://www.staatstheater-cottbus.de/de/programm/spielplan.html"], parse: (b) => parseTheater(b) },
  gladhouse: { kind: "culture", every: 6 * H, url: () => ["https://www.gladhouse.de/"], parse: (b) => parseGladhouse(b) },
  cottbus_city: { kind: "culture", every: 6 * H, url: () => ["https://cottbus.de/veranstaltungen/"], parse: (b) => parseCottbus(b) },
  devpost: { kind: "career", every: 12 * H, url: () => ["https://devpost.com/api/hackathons?status[]=upcoming&status[]=open"], parse: (b) => parseDevpost(JSON.parse(b)) },
  meetup: { kind: "career", every: 6 * H, url: (c) => c.events.meetup_groups.map((g) => `https://www.meetup.com/${encodeURIComponent(g)}/events/ical/`), parse: (b) => parseIcal(b, "meetup") },
  btu: { kind: "career", every: 12 * H, url: () => ["https://www.b-tu.de/veranstaltungen"], parse: (b) => parseBtu(b) },
};

// ---------------------------------------------------------------- storage
const ready = new WeakSet<D1Database>();
async function ensureTable(db: D1Database) {
  if (ready.has(db)) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, dkey TEXT, title TEXT, starts TEXT,
    ends TEXT, place TEXT, price REAL, url TEXT, tickets TEXT, note TEXT, tag TEXT, status TEXT NOT NULL, why TEXT,
    first_seen INTEGER NOT NULL, posted_at INTEGER, msg_id INTEGER)`).run();
  // added later: the poster
  const { results } = await db.prepare("PRAGMA table_info(events)").all<{ name: string }>();
  if (!(results ?? []).some((c) => c.name === "image")) await db.prepare("ALTER TABLE events ADD COLUMN image TEXT").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS events_status ON events(status)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS events_dkey ON events(dkey)").run();
  ready.add(db);
}
/** One card per show: "Nabucco" on four dates is the same show. */
const dkeyOf = (e: Event) => `${e.kind}|${e.title.toLowerCase().replace(/[^\p{L}\d]+/gu, "")}`.slice(0, 160);

// ---------------------------------------------------------------- settings
export interface EventSettings { budget: number; culture: boolean; career: boolean }
export async function eventSettings(store: Store, cfg: Config): Promise<EventSettings> {
  const b = Number(await store.kvGet("events_budget"));
  const on = async (k: Kind) => { const v = await store.kvGet(`events_${k}_on`); return v === null ? cfg.events[k] : v !== "0"; };
  return { budget: (await store.kvGet("events_budget")) !== null && Number.isFinite(b) ? b : cfg.events.max_price, culture: await on("culture"), career: await on("career") };
}

// ---------------------------------------------------------------- one tick
export async function eventsStep(env: { DB: D1Database }, store: Store, tg: Telegram): Promise<string> {
  const cfg = await loadConfig(store);
  if (!cfg) return `events: ${NO_CONFIG}`;
  if (!cfg.modules.events) return "events: off";
  const s = await eventSettings(store, cfg);
  if (!s.culture && !s.career) return "events: all paused";
  const db = env.DB;
  await ensureTable(db);
  const did: string[] = [];
  if (s.culture) await introduce(cfg, store, tg, "culture_events",
    `🎭 <b>Cultural events</b> in ${esc(cfg.city)} will be posted here: theatre, concerts, exhibitions and more in the next few weeks, ` +
    `up to ${s.budget} € or free (some don't list a price).\n\n/events budget ${s.budget + 5} - another budget · /events culture off - pause · /events - settings`);
  if (s.career) await introduce(cfg, store, tg, "career_events",
    `🎤 <b>Career events</b> will be posted here: meetups, hackathons, career and scholarship dates.\n\n/events career off - pause · /events - settings`);

  // the most overdue source of the kinds that are on
  const checked = await store.kvPrefix("events_checked:");
  const due = cfg.events.sources.filter((k) => SOURCES[k] && s[SOURCES[k].kind])
    .map((k) => ({ k, late: now() - Number(checked[`events_checked:${k}`] ?? 0) - SOURCES[k].every }))
    .filter((x) => x.late >= 0).sort((a, b) => b.late - a.late)[0];
  if (due) did.push(await read(db, store, cfg, due.k));
  // kv events_repost_before=<time>: cards posted before then that now have a
  // poster (and the theatre's, whose poster is fetched when posting) come down
  // and go out again with it
  const before = Number((await store.kvGet("events_repost_before")) ?? 0);
  if (before) {
    const { results } = await db.prepare(
      `SELECT id, msg_id FROM events WHERE status='posted' AND posted_at < ? AND (image IS NOT NULL OR id LIKE 'theater:%')`).bind(before).all<{ id: string; msg_id: number | null }>();
    for (const r of results ?? []) {
      if (r.msg_id) try { await tg.deleteMessage(r.msg_id); } catch { /* gone, or older than 48 h */ }
      await db.prepare("UPDATE events SET status='new', posted_at=NULL, msg_id=NULL WHERE id=?").bind(r.id).run();
    }
    if (results?.length) did.push(`${results.length} taken down for their poster`);
  }
  const n = await post(db, store, tg, cfg, s);
  if (n) did.push(`${n} posted`);
  return `events: ${did.join(", ") || "nothing to do"}`;
}

async function read(db: D1Database, store: Store, cfg: Config, key: string): Promise<string> {
  const src = SOURCES[key];
  const watch = src.kind === "culture" ? "events_culture" : "events_career";
  await store.kvSet(`events_checked:${key}`, String(now()));
  const found: Event[] = [];
  try {
    for (const url of src.url(cfg)) {
      const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" } });
      if (!r.ok) throw new Error(`${key} answered ${r.status}`);
      found.push(...src.parse(await r.text(), key));
    }
  } catch (e) {
    await noteError(store, watch, e);
    return `${key}: ${(e as any)?.message ?? e}`;
  }
  await noteOk(store, watch, found.length);
  let fresh = 0;
  for (const e of found) {
    const known = await db.prepare("SELECT image FROM events WHERE id=?").bind(e.id).first<{ image: string | null }>();
    if (known) {
      // found before this source's posters were read: add it
      if (!known.image && e.image) await db.prepare("UPDATE events SET image=? WHERE id=?").bind(e.image, e.id).run();
      continue;
    }
    fresh++;
    await db.prepare(`INSERT OR IGNORE INTO events (id,kind,dkey,title,starts,ends,place,price,url,tickets,note,tag,status,first_seen,image)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?)`).bind(e.id, e.kind, dkeyOf(e), e.title, e.starts, e.ends ?? null, e.place,
        e.price, e.url, e.tickets ?? null, e.note, e.tag, now(), e.image ?? null).run();
  }
  return `${key} ${found.length} events, ${fresh} new`;
}

// ---------------------------------------------------------------- posting
const DAY = 86400_000;
// not for a student's evening: kids' and school shows, weekly markets, info for school leavers
const NOT_FOR_US = /für minis|kinder|kita|schul(?!d)|familien|krabbel|wochenmarkt|\bmarkt\b|duale[sn]? studium|baby/i;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Now as the listings write it: Berlin time, "2026-11-07T20:51". */
const berlinNow = () => new Date(Date.now()).toLocaleString("sv-SE", { timeZone: "Europe/Berlin" }).replace(" ", "T").slice(0, 16);

interface Row { id: string; kind: Kind; dkey: string; title: string; starts: string; ends: string | null; place: string;
  price: number | null; url: string; tickets: string | null; note: string; tag: string; image?: string | null }

/** The theatre's listing has no pictures; the show's own page leads with a production photo. */
async function theaterPoster(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const src = /<img[^>]+src="([^"]*\/cache\/img\/[^"]+\.jpe?g)"/i.exec(await r.text())?.[1];
    return src ? (src.startsWith("http") ? src : `https://www.staatstheater-cottbus.de${src}`) : null;
  } catch { return null; }
}

/** With a poster: a photo with the card as its caption (1024 characters at most); else text. */
async function send(tg: Telegram, r: Row, where: Record<string, unknown>): Promise<any> {
  if (r.image) {
    let caption = eventCard(r);
    if (caption.length > 1024) caption = eventCard({ ...r, note: r.note.slice(0, Math.max(0, r.note.length - (caption.length - 1020))) + "…" });
    try { return await tg.sendPhoto(r.image, caption, undefined, where); }
    catch (e: any) { if (String(e?.message).includes(" 429")) throw e; /* a picture Telegram can't fetch: as text */ }
  }
  return tg.send(eventCard(r), where);
}

/**
 * Why an event isn't posted (now), or null. "later" (not yet in the window)
 * and "over budget" wait: a higher budget or the date coming closer lets
 * them out. The rest are left out for good.
 */
function holdBack(r: Row, s: EventSettings, cfg: Config): string | null {
  if (!s[r.kind]) return "paused";
  if (NOT_FOR_US.test(`${r.title} ${r.tag}`)) return "not for us";
  const local = berlinNow(), today = local.slice(0, 10);
  const last = r.ends ?? r.starts.slice(0, 10);
  if (r.starts && last < today) return "over";
  // started already today (a single show with a time; not a run like an exhibition)
  if (!r.ends && r.starts.length > 10 && r.starts < local) return "over";
  const window = r.kind === "culture" ? cfg.events.culture_days : cfg.events.career_days;
  if (r.starts && r.starts.slice(0, 10) > isoDay(Date.now() + window * DAY)) return "later";
  if (r.kind === "culture" && r.price !== null && r.price > s.budget) return "over budget";
  return null;
}

async function post(db: D1Database, store: Store, tg: Telegram, cfg: Config, s: EventSettings): Promise<number> {
  const { results } = await db.prepare(
    "SELECT * FROM events WHERE status='new' ORDER BY COALESCE(starts, '9999'), first_seen LIMIT 40").all<Row>();
  let n = 0;
  for (const r of results ?? []) {
    if (n >= POST_PER_TICK) break;
    const why = holdBack(r, s, cfg);
    if (why === "later" || why === "over budget") continue;     // stays new: it may still fit
    if (why) { await db.prepare("UPDATE events SET status='skipped', why=? WHERE id=?").bind(why, r.id).run(); continue; }
    // the same show on another date was posted already
    if (await db.prepare("SELECT 1 FROM events WHERE dkey=? AND status='posted' LIMIT 1").bind(r.dkey).first()) {
      await db.prepare("UPDATE events SET status='skipped', why='same show posted' WHERE id=?").bind(r.id).run();
      continue;
    }
    try {
      if (!r.image && r.id.startsWith("theater:")) {
        r.image = await theaterPoster(r.url);
        if (r.image) await db.prepare("UPDATE events SET image=? WHERE id=?").bind(r.image, r.id).run();
      }
      const sent = await send(tg, r, inTopic(await topicOf(cfg, store, tg, r.kind === "culture" ? "culture_events" : "career_events")));
      await db.prepare("UPDATE events SET status='posted', posted_at=?, msg_id=? WHERE id=?").bind(now(), sent?.result?.message_id ?? null, r.id).run();
      n++;
    } catch (e: any) {
      if (String(e?.message).includes(" 429")) break;
      await db.prepare("UPDATE events SET status='skipped', why=? WHERE id=?").bind(`could not post: ${String(e?.message ?? e).slice(0, 100)}`, r.id).run();
    }
  }
  return n;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (iso: string) => { const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const EMOJI: Record<string, string> = { Hackathon: "🏆", Meetup: "🎤", Scholarship: "🎓", BTU: "🎓" };

export function eventCard(r: Row): string {
  const when = !r.starts ? "" : r.ends && r.ends !== r.starts.slice(0, 10)
    ? `${fmtDay(r.starts)} – ${fmtDay(r.ends)}` : `${fmtDay(r.starts)}${r.starts.length > 10 ? `, ${r.starts.slice(11, 16)}` : ""}`;
  const price = r.price === null ? "💶 price not listed" : r.price === 0 ? "🆓 <b>Free</b>" : `💶 ${String(r.price).replace(".", ",")} €`;
  const icon = EMOJI[r.tag] ?? (r.kind === "culture" ? "🎭" : "🎤");
  return [
    `${icon} <b>${esc(r.title)}</b>${r.tag && !EMOJI[r.tag] ? `\n<i>${esc(r.tag)}</i>` : ""}`,
    [when ? `📅 ${when}` : "", r.place ? `📍 ${esc(r.place)}` : "", r.kind === "culture" || r.price ? price : ""].filter(Boolean).join("\n"),
    r.note ? esc(r.note) : "",
    [`<a href="${esc(r.url)}">details</a>`, r.tickets ? `<a href="${esc(r.tickets)}">tickets</a>` : ""].filter(Boolean).join(" · "),
  ].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------- /events
export async function eventsCard(store: Store, cfg: Config): Promise<[string, Button[][]]> {
  const s = await eventSettings(store, cfg);
  return [[
    `🎭 <b>Events</b>`, "",
    `Cultural events: ${s.culture ? `on, up to ${s.budget} € or free` : "⏸ paused"}`,
    `Career events: ${s.career ? "on" : "⏸ paused"}`, "",
    `<i>/events budget 15 · /events culture off · /events career on - anyone here can change it</i>`,
  ].join("\n"), [
    [{ text: "−5 €", callback_data: "ev:budget:-5" }, { text: `≤ ${s.budget} €`, callback_data: "ev:noop" }, { text: "+5 €", callback_data: "ev:budget:+5" }],
    [{ text: `🎭 ${s.culture ? "⏸ pause" : "▶️ on"}`, callback_data: `ev:culture:${s.culture ? "off" : "on"}` },
     { text: `🎤 ${s.career ? "⏸ pause" : "▶️ on"}`, callback_data: `ev:career:${s.career ? "off" : "on"}` }],
  ]];
}

/** budget ±n or n; culture|career on|off. The answer to show. */
export async function setEvents(store: Store, cfg: Config, what: string, value: string): Promise<string> {
  const s = await eventSettings(store, cfg);
  if (what === "budget") {
    const v = Math.round(/^[+-]/.test(value) ? s.budget + Number(value) : Number(value));
    if (!value || !Number.isFinite(v)) return "Try /events budget 15";
    const b = Math.min(200, Math.max(0, v));
    await store.kvSet("events_budget", String(b));
    return `🎭 Cultural events: up to ${b} € or free`;
  }
  if ((what === "culture" || what === "career") && (value === "on" || value === "off")) {
    await store.kvSet(`events_${what}_on`, value === "on" ? "1" : "0");
    return `${what === "culture" ? "🎭 Cultural" : "🎤 Career"} events: ${value === "on" ? "on" : "paused"}`;
  }
  return "Try /events budget 15, /events culture off, /events career on";
}

/** One line for /status. */
export async function eventsLine(store: Store, db: D1Database, cfg: Config): Promise<string> {
  await ensureTable(db);
  const s = await eventSettings(store, cfg);
  const r = await db.prepare("SELECT SUM(kind='culture' AND status='posted') c, SUM(kind='career' AND status='posted') k FROM events").first<{ c: number | null; k: number | null }>();
  return `Events:          ${s.culture ? `🎭 ${r?.c ?? 0} posted (≤ ${s.budget} €)` : "🎭 paused"} · ${s.career ? `🎤 ${r?.k ?? 0} posted` : "🎤 paused"}`;
}
