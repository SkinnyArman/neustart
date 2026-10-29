// The whole setup in one place: where you're moving, what the bot looks for
// and for whom. It's written in neustart.yaml (see neustart.example.yaml),
// stored in D1 as kv "config" by `npm run config`, and read here.
//
// normalize() fills in the defaults and checks it. A module whose part of the
// config doesn't add up is switched off with a reason, so a typo in the jobs
// section can't stop the room search.

import type { Profile } from "./settings.ts";
import type { Store } from "./store.ts";

export type ModuleKey = "rooms" | "finds" | "jobs" | "casual_jobs";
export const MODULES: ModuleKey[] = ["rooms", "finds", "jobs", "casual_jobs"];
export type ItemKey = "bike" | "bed" | "kommode" | "carpet" | "free";
export const ITEM_KEYS: ItemKey[] = ["bike", "bed", "kommode", "carpet", "free"];
/** Where each kind of post goes: one forum topic per module, and per find. */
export type TopicKey = "rooms" | ItemKey | "jobs" | "casual_jobs";
export const TOPIC_KEYS: TopicKey[] = ["rooms", ...ITEM_KEYS, "jobs", "casual_jobs"];

export interface Person {
  id: string;             // what commands and buttons use: /skills diba
  name: string;           // on cards: "For Diba"
  full_name: string;      // signs the cover letters
  icon: string;
  field: string;          // "not data work"
  wants: string;          // for the AI: which roles fit
  searches: string[];     // Jobbörse keyword searches
  title_words: string[];  // a title has to contain one of these (regex fragments)
  summary: string;        // for the AI: who they are
  skills: string[];
  cv: string;
  availability: string;   // the cover letter's availability sentence
  active: boolean;
}

export interface City { name: string; radius_km: number }

export interface Config {
  city: string;
  /** Kleinanzeigen's name and id for the city: /s-cottbus/l7743 */
  ka: { slug: string; id: string } | null;
  modules: Record<ModuleKey, boolean>;
  /** Why a module is off when the config wanted it on. */
  problems: string[];
  /** Fixed topic ids; the rest are created on first use ("auto"), or none at all. */
  topics: Partial<Record<TopicKey, number>>;
  topics_mode: "auto" | "none";
  rooms: Profile;
  finds: {
    radius_km: number;
    for_whom: string;
    items: Record<ItemKey, { on: boolean; max_price: number; min_rating: number; width_cm: number; room_m2: number }>;
  };
  jobs: {
    student_permit: boolean;
    situation: string;
    cities: City[];
    remote: boolean;
    arbeitnow: boolean;
    people: Person[];
  };
  casual_jobs: { radius_km: number; only_city: boolean };
}

const ITEM_DEFAULTS: Record<ItemKey, { max_price: number; min_rating: number }> = {
  bike: { max_price: 30, min_rating: 0 }, bed: { max_price: 100, min_rating: 0 }, kommode: { max_price: 35, min_rating: 0 },
  carpet: { max_price: 30, min_rating: 0 }, free: { max_price: 0, min_rating: 6 },
};
const ICONS = ["🧑‍💻", "👩‍💻", "👨‍💻", "🧑‍🔬", "🧑‍🎓"];
// words in a search that say nothing about the work itself
const GENERIC = new Set(["werkstudent", "werkstudentin", "working", "student", "junior", "praktikum", "praktikant",
  "intern", "internship", "trainee", "m/w/d", "mwd", "und", "and", "für", "for", "in", "im"]);

const str = (x: unknown, d = "") => (typeof x === "string" ? x.trim() : typeof x === "number" ? String(x) : d);
const num = (x: unknown, d: number) => (x === undefined || x === null || x === "" || !Number.isFinite(Number(x)) ? d : Number(x));
const bool = (x: unknown, d: boolean) => (typeof x === "boolean" ? x : x === undefined || x === null ? d : !/^(false|no|off|0)$/i.test(String(x)));
const list = (x: unknown): string[] => (Array.isArray(x) ? x.map((v) => str(v)).filter(Boolean) : typeof x === "string" && x.trim() ? [x.trim()] : []);
export const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Kleinanzeigen's place for the city, from any of: a search URL for it
 * ("https://www.kleinanzeigen.de/s-cottbus/l7743", or a category search like
 * ".../s-fahrraeder/cottbus/c217l7743"), "cottbus/l7743", or {slug, id}.
 */
export function parseKa(x: unknown): { slug: string; id: string } | null {
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    const slug = str(o.slug), id = str(o.id).replace(/^l/, "");
    return slug && /^\d+$/.test(id) ? { slug, id } : null;
  }
  const s = str(x);
  if (!s) return null;
  const path = s.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "");
  // "c217l4233r20+fahrraeder.art_s:damen": the place code is the part before the "+"
  const parts = path.split("/").filter(Boolean).map((p) => p.split("+")[0]);
  const at = parts.findIndex((p) => /^(?:k0)?(?:c\d+)?l\d+(?:r\d+)?$/.test(p));
  if (at < 0) return null;
  const id = /l(\d+)/.exec(parts[at])![1];
  // the city is the path part just before the place code, or the "s-<city>" part
  const before = parts.slice(0, at).filter((p) => !p.includes(":") && !/^preis/.test(p));
  const last = before.at(-1) ?? "";
  const slug = before.length === 1 && last.startsWith("s-") ? last.slice(2) : last;
  return slug && !slug.startsWith("s-") ? { slug, id } : null;
}

export function normalize(raw: unknown): Config {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const problems: string[] = [];
  const city = str(r.city);
  const want = (k: ModuleKey) => bool(r.modules?.[k], true);
  const modules = Object.fromEntries(MODULES.map((k) => [k, want(k)])) as Record<ModuleKey, boolean>;
  const off = (k: ModuleKey, why: string) => { if (modules[k]) problems.push(`${k}: ${why}`); modules[k] = false; };
  if (!city) for (const k of MODULES) off(k, "no city set");

  // ---- topics
  const topics: Partial<Record<TopicKey, number>> = {};
  const t = r.topics;
  const topics_mode = t === "none" || t === false ? "none" : "auto";
  if (t && typeof t === "object")
    for (const k of TOPIC_KEYS) if (Number(t[k]) > 0) topics[k] = Number(t[k]);

  // ---- rooms
  const rooms = (r.rooms ?? {}) as Profile;
  if (modules.rooms) {
    if (!str(rooms.about?.name)) off("rooms", "rooms.about.name is missing");
    else if (!(rooms.searches ?? []).some((s) => str(s?.url))) off("rooms", "rooms.searches has no search");
  }

  // ---- finds
  const ka = parseKa(r.kleinanzeigen);
  if (modules.finds && !ka) off("finds", "kleinanzeigen is missing or not a Kleinanzeigen search URL for your city");
  const f = r.finds ?? {};
  const items = {} as Config["finds"]["items"];
  for (const k of ITEM_KEYS) {
    const it = f.items?.[k] ?? {};
    items[k] = {
      on: bool(it.on, true),
      max_price: num(it.max_price, ITEM_DEFAULTS[k].max_price),
      min_rating: num(it.min_rating, ITEM_DEFAULTS[k].min_rating),
      width_cm: num(it.width_cm, 140),
      room_m2: num(it.room_m2, 25),
    };
  }
  const finds = {
    radius_km: num(f.radius_km, 30),
    for_whom: str(f.for_whom, `someone who just moved to ${city || "the city"} and is setting up a room in a shared flat (WG)`),
    items,
  };

  // ---- jobs
  const j = r.jobs ?? {};
  const student_permit = bool(j.student_permit, false);
  const shared = str(j.availability, student_permit
    ? `student in ${city}, as a Werkstudent up to 20 hours a week during the semester` : `based in ${city}`);
  const people: Person[] = [];
  (Array.isArray(j.people) ? j.people : []).forEach((p: any, i: number) => {
    const name = str(p?.name);
    const id = slugify(str(p?.id) || name);
    const searches = list(p?.searches);
    if (!name || !id) return problems.push(`jobs: person ${i + 1} has no name`);
    if (!searches.length) return problems.push(`jobs: ${name} has no searches`);
    if (people.some((q) => q.id === id)) return problems.push(`jobs: two people are called ${id}`);
    const words = list(p?.title_words);
    const bad = words.find((w) => { try { new RegExp(w); return false; } catch { return true; } });
    if (bad !== undefined) return problems.push(`jobs: ${name}'s title word "${bad}" isn't a valid pattern`);
    people.push({
      id, name, full_name: str(p.full_name, name), icon: str(p.icon, ICONS[i % ICONS.length]),
      field: str(p.field, `${name}'s`), wants: str(p.wants, searches.join(", ")), searches,
      // by default: the words of the searches themselves ("Data Analyst" -> data, analyst)
      title_words: words.length ? words
        : [...new Set(searches.flatMap((s) => s.toLowerCase().split(/[^\p{L}\d+#.]+/u)).filter((w) => w.length > 1 && !GENERIC.has(w)))],
      summary: str(p.summary), skills: list(p.skills), cv: str(p.cv), availability: str(p.availability, shared),
      active: bool(p.active, true),
    });
  });
  if (modules.jobs && !people.length) off("jobs", "jobs.people is empty");
  const cities: City[] = (Array.isArray(j.cities) ? j.cities : [])
    .map((c: any) => (typeof c === "string" ? { name: c, radius_km: 50 } : { name: str(c?.name), radius_km: num(c?.radius_km, 50) }))
    .filter((c: City) => c.name);
  const jobs = {
    student_permit,
    situation: str(j.situation, student_permit
      ? `${people.length === 1 ? `${people[0].name} is a student` : "They are students"} in ${city} on a student residence permit: ` +
        `they may work up to 20 hours a week during the semester (Werkstudent jobs and internships fit); a full-time job does not fit that permit.`
      : ""),
    cities: cities.length ? cities : [{ name: city, radius_km: 50 }],
    remote: bool(j.remote, true),
    arbeitnow: bool(j.arbeitnow, true),
    people,
  };

  return {
    city, ka, modules, problems, topics, topics_mode, rooms, finds, jobs,
    casual_jobs: { radius_km: num(r.casual_jobs?.radius_km, 25), only_city: bool(r.casual_jobs?.only_city, false) },
  };
}

// Read on every invocation (one small D1 row), parsed only when it changed.
let cache: { raw: string; config: Config } | null = null;

/** The config, or null before `npm run config` has stored one. */
export async function loadConfig(store: Store): Promise<Config | null> {
  const raw = await store.kvGet("config");
  if (!raw) return null;
  if (cache?.raw !== raw) cache = { raw, config: normalize(JSON.parse(raw)) };
  return cache.config;
}

export const NO_CONFIG = "no config yet - fill in neustart.yaml, then run: npm run config";
