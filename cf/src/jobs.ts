// Jobs for the people in the config's jobs section, posted to the Jobs topic
// as cards that double as an application tracker.
//
// Sources, both public and meant to be read by programs:
//   - Bundesagentur für Arbeit, Jobbörse: each person's keyword searches
//     around each of the config's cities, two per tick in rotation
//   - Arbeitnow: a free feed of German (often English-speaking) tech jobs,
//     every two hours; in those cities or remote
//
// Rules drop the obvious misses for free (senior/lead roles, Ausbildung,
// titles without any of a person's title words). One cheap AI call per
// remaining job decides who it's for, why, what's missing, the German level,
// hours, start, deadline. With student_permit, full-time roles are dropped:
// a student residence permit can't cover them. Cover letters are only written
// on request, with the better model.
//
// Personal data (profiles, CV text, skills) lives in D1 (kv config, and
// jobs_skills:<id> once changed with /skills), never in this public repo.

import { aiFailed, aiWorked } from "./aikey.ts";
import { loadConfig, NO_CONFIG, type Config, type Person } from "./config.ts";
import { fmtLeft } from "./settings.ts";
import type { Store } from "./store.ts";
import { esc, inTopic, type Button, type Telegram } from "./telegram.ts";
import { xlsx } from "./xlsx.ts";
import { nudgeStep } from "./nudge.ts";
import { introduce, topicOf } from "./topics.ts";
import { noteError, noteOk } from "./watch.ts";

export const JOBS_CRON = "3,13,23,33,43,53 * * * *";
const QUERIES_PER_TICK = 2;
const ASSESS_PER_TICK = 3;
const POST_PER_TICK = 4;
const MAX_ATTEMPTS = 3;
const FOLLOW_UP_DAYS = 10;
const ARBEITNOW_EVERY = 2 * 3600;
const LOCK_SECONDS = 300;

type Jobs = Config["jobs"];
const ids = (j: Jobs) => j.people.map((p) => p.id);
const byId = (j: Jobs, id: string | null | undefined) => j.people.find((p) => p.id === id);
const nameOf = (j: Jobs, id: string) => byId(j, id)?.name ?? id;

/**
 * Who is searching right now: the people not marked `active: false`, or, when
 * set, kv jobs_active ("diba" or "diba,arman"). Only they get searches,
 * matches, board lines and reports.
 */
export async function activePeople(store: Store, j: Jobs): Promise<string[]> {
  const raw = await store.kvGet("jobs_active");
  const a = raw === null ? j.people.filter((p) => p.active).map((p) => p.id)
    : raw.split(",").map((x) => x.trim().toLowerCase()).filter((x) => ids(j).includes(x));
  return a.length ? a : ids(j).slice(0, 1);
}

// The AI says a job is for one person, or for everyone ("both" when there are
// two, "all" otherwise); a card for some of several is stored as "a,b".
const everyone = (j: Jobs) => (j.people.length === 2 ? "both" : "all");
/** The people a stored `person` names. */
const peopleOf = (j: Jobs, person: string | null): string[] =>
  !person ? [] : person === "both" || person === "all" ? ids(j) : person.split(",").filter((x) => ids(j).includes(x));
/** One known person, or null. */
const single = (j: Jobs, person: string | null) => (person && byId(j, person) ? person : null);

export interface JobsEnv {
  DB: D1Database;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;      // cover letters
  FINDS_MODEL?: string;      // matching (the budget model)
}

const now = () => Math.floor(Date.now() / 1000);
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10).split("-").reverse().slice(0, 2).join(".");

// ---------------------------------------------------------------- searches
/** Each active person's keywords × each city, in config order. */
export const searchesFor = (j: Jobs, active: string[]) =>
  j.people.filter((p) => active.includes(p.id))
    .flatMap((p) => p.searches.flatMap((q) => j.cities.map((c) => ({ q, wo: c.name, r: c.radius_km }))));

const BA = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service";
const BA_KEY = { "X-API-Key": "jobboerse-jobsuche" };   // the Jobbörse's public client key

// ---------------------------------------------------------------- rules
const SENIOR = /\b(senior|sr\.|lead|leitung|leiter|head of|principal|staff|director|chief|vp)\b|teamleit|abteilungsleit|bereichsleit/;
const NOT_A_JOB = /\b(ausbildung|azubi|auszubildende|duales studium|dual(er|es)? student|umschulung|minijob|freelance|freiberuf|selbstständig|ehrenamt)\b/;
// the title has to be about the work someone searching does at all
const onTopic = new WeakMap<Person, RegExp>();
const topicRx = (p: Person) => {
  let rx = onTopic.get(p);
  if (!rx) { rx = new RegExp(p.title_words.map((w) => w.toLowerCase()).join("|")); onTopic.set(p, rx); }
  return rx;
};

// a full-time listing is still fine when the title says it's for students or part-time
const STUDENT = /werkstudent|working student|studentische|student job|praktik|intern|thesis|abschlussarbeit|masterarbeit|teilzeit|part[- ]?time/;
const FULL_TIME = /full[- ]?time|vollzeit/;

/** Why a job is clearly not for anyone searching, by title and listed hours, or null. */
export function jobRejectReason(title: string, j: Jobs, active: string[] = ids(j), kind = ""): string | null {
  const t = title.toLowerCase();
  if (SENIOR.test(t)) return "senior or lead role";
  if (NOT_A_JOB.test(t)) return "apprenticeship, freelance or similar";
  if (j.student_permit && (FULL_TIME.test(kind.toLowerCase()) || FULL_TIME.test(t)) && !STUDENT.test(t)) return "full-time";
  const who = j.people.filter((p) => active.includes(p.id));
  if (!who.some((p) => topicRx(p).test(t))) return `not ${who.map((p) => p.field).join(" or ")} work`;
  return null;
}

/** Same job from another source: company + title, without legal forms and (m/w/d). */
export const dedupeKey = (company: string, title: string) =>
  (company.toLowerCase().replace(/\b(gmbh|ag|se|kg|co|mbh|ug|e\.v|inc|ltd)\b|[^\p{L}\d]+/gu, "") + "|" +
   title.toLowerCase().replace(/\((m|w|d|f|x|div)[^)]*\)/g, "").replace(/[^\p{L}\d]+/gu, "")).slice(0, 160);

export const strip = (html: string) =>
  html.replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    // numeric codes ("&#160;", "&#8211;"), often double-escaped as "&amp;#160;"
    .replace(/&#(\d+);/g, (_, d) => (d === "160" ? " " : String.fromCodePoint(Number(d))))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();

// ---------------------------------------------------------------- storage
const COLUMNS: Record<string, string> = {
  id: "TEXT PRIMARY KEY",        // ba:<refnr> | an:<slug>
  dkey: "TEXT",                  // dedupeKey across sources
  source: "TEXT", title: "TEXT", company: "TEXT", place: "TEXT", url: "TEXT",
  remote: "INTEGER", kind: "TEXT", text: "TEXT",
  status: "TEXT NOT NULL",       // new → ready → posted → (approved: waiting list →) applied|already → interview → offer → accepted|declined | rejected; skipped
  why: "TEXT", person: "TEXT",   // a person's id, "both"/"all", or "a,b"; who applied, once applied
  facts: "TEXT",                 // JSON from the AI: why, gaps, german, hours, start, deadline, lang, skills
  attempts: "INTEGER NOT NULL DEFAULT 0",
  first_seen: "INTEGER NOT NULL", posted_at: "INTEGER", applied_at: "INTEGER",
  replied_at: "INTEGER", reminded: "INTEGER NOT NULL DEFAULT 0", msg_id: "INTEGER",
  checked_at: "INTEGER",         // when a posted job was last looked up again
  approved_at: "INTEGER",        // put on the waiting list (🔖 Apply later)
  was: "TEXT",                   // JSON {status, person} before the last button: what ↩️ Undo goes back to
};
const ready = new WeakSet<D1Database>();
async function ensureTable(db: D1Database) {
  if (ready.has(db)) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (${Object.entries(COLUMNS).map(([k, t]) => `${k} ${t}`).join(", ")})`).run();
  const { results } = await db.prepare("PRAGMA table_info(jobs)").all<{ name: string }>();
  const have = new Set((results ?? []).map((r) => r.name));
  for (const [k, t] of Object.entries(COLUMNS))
    if (!have.has(k)) await db.prepare(`ALTER TABLE jobs ADD COLUMN ${k} ${t.replace(" NOT NULL", "")}`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS jobs_dkey ON jobs(dkey)").run();
  ready.add(db);
}

export interface JobRow {
  id: string; dkey: string; source: string; title: string; company: string; place: string;
  url: string; remote: number; kind: string | null; text: string | null; status: string;
  why: string | null; person: string | null; facts: string | null; attempts: number;
  first_seen: number; posted_at: number | null; applied_at: number | null;
  replied_at: number | null; reminded: number; msg_id: number | null; approved_at?: number | null; was?: string | null;
}
interface Facts {
  for: string;   // a person's id, everyone ("both"/"all"), some ("a,b"), or "none"
  reason?: string; kind: string; why: string;
  gaps: string[]; german: string; hours: string; start: string; deadline: string;
  lang: string; skills: string[];
}

const setJob = (db: D1Database, id: string, f: Record<string, unknown>) => {
  const keys = Object.keys(f);
  return db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`)
    .bind(...keys.map((k) => f[k]), id).run();
};

async function takeLock(db: D1Database): Promise<boolean> {
  const t = now();
  const r = await db.prepare(
    `INSERT INTO kv (k, v) VALUES ('jobs_lock', ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(kv.v AS INTEGER) < ?`)
    .bind(String(t), t - LOCK_SECONDS).run();
  return (r.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------- fetching
interface Found { id: string; source: string; title: string; company: string; place: string; url: string; remote: boolean; kind: string; text?: string }

async function fetchBA(q: { q: string; wo: string; r: number }): Promise<Found[]> {
  const u = new URL(`${BA}/pc/v6/jobs`);
  for (const [k, v] of Object.entries({ was: q.q, wo: q.wo, umkreis: String(q.r), veroeffentlichtseit: "7", size: "50" }))
    u.searchParams.set(k, v);
  const r = await fetch(u, { headers: BA_KEY });
  if (!r.ok) throw new Error(`Jobbörse ${r.status}`);
  const d = (await r.json()) as any;
  return (d.ergebnisliste ?? [])
    .filter((j: any) => !["AUSBILDUNG", "SELBSTAENDIGKEIT"].includes(j.stellenangebotsart))
    .map((j: any) => {
      const loc = j.stellenlokationen?.[0]?.adresse ?? {};
      return {
        id: "ba:" + j.referenznummer, source: "Jobbörse", title: j.stellenangebotsTitel ?? "",
        company: j.firma ?? "", place: [loc.ort, j.homeofficemoeglich ? "home office possible" : ""].filter(Boolean).join(" · "),
        url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(j.referenznummer)}`,
        remote: !!j.homeofficemoeglich,
        kind: j.stellenangebotsart === "PRAKTIKUM_TRAINEE" ? "student/intern" : j.arbeitszeitVollzeit ? "full-time" : "",
      };
    });
}

async function detailsBA(id: string): Promise<string> {
  const ref = id.slice(3);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(ref)));
  const r = await fetch(`${BA}/pc/v4/jobdetails/${b64}`, { headers: BA_KEY });
  if (!r.ok) throw new Error(`Jobbörse details ${r.status}`);
  const d = (await r.json()) as any;
  return [d.stellenangebotsBeschreibung ?? "", d.externeURL ? `\nApply: ${d.externeURL}` : ""].join("");
}

const escRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function fetchArbeitnow(jobs: Jobs): Promise<Found[]> {
  const r = await fetch("https://www.arbeitnow.com/api/job-board-api");
  if (!r.ok) throw new Error(`Arbeitnow ${r.status}`);
  const d = (await r.json()) as any;
  const here = new RegExp(jobs.cities.map((c) => escRx(c.name.toLowerCase())).join("|"), "i");
  return (d.data ?? [])
    .filter((j: any) => (jobs.remote && j.remote) || here.test(j.location ?? ""))
    .map((j: any) => ({
      id: "an:" + j.slug, source: "Arbeitnow", title: j.title ?? "", company: j.company_name ?? "",
      place: [j.location, j.remote ? "remote" : ""].filter(Boolean).join(" · "), url: j.url,
      remote: !!j.remote, kind: (j.job_types ?? []).join(", "), text: strip(j.description ?? ""),
    }));
}

// ---------------------------------------------------------------- the AI
/** The people with their skills as they are now: /skills changes win over the config. */
async function people(store: Store, j: Jobs): Promise<Record<string, Person>> {
  const out: Record<string, Person> = {};
  for (const p of j.people) {
    const s = await store.kvGet(`jobs_skills:${p.id}`);
    out[p.id] = s ? { ...p, skills: JSON.parse(s) } : p;
  }
  return out;
}

const COUNT = ["no", "one", "two", "three", "four", "five", "six"];
const MATCH = (j: Jobs) => {
  const n = j.people.length;
  const q = (s: string) => JSON.stringify(s);
  const fors = [...ids(j), ...(n > 1 ? [everyone(j)] : []), "none"].map(q).join("|");
  const none = j.student_permit
    ? `"none" for senior roles, unrelated work, roles needing far more experience than they have, roles requiring native German, and full-time jobs - including a regular job whose ad never says it's for students, part-time or an internship (in Germany those are full-time). Keep Werkstudent jobs, internships, thesis positions and jobs that say part-time is possible. If "none", give reason (max 8 words, "full-time" for full-time jobs) and leave the rest empty.`
    : `"none" for senior roles, unrelated work, roles needing far more experience than they have, and roles requiring native German. If "none", give reason (max 8 words) and leave the rest empty.`;
  return `You match German job ads to ${COUNT[n] ?? n} job seeker${n === 1 ? "" : "s"}.${j.situation ? ` ${j.situation}` : ""}

${j.people.map((p) => `${p.name.toUpperCase()} wants: ${p.wants}`).join("\n")}

Return JSON only:
{"for": ${fors}, "reason": string, "kind": "werkstudent"|"internship"|"thesis"|"part-time"|"other", "why": string, "gaps": [string], "german": string, "hours": string, "start": string, "deadline": string, "lang": "de"|"en", "skills": [string]}

for: who should apply, from the profiles below. ${none}
why: one line, under 110 characters, why it fits that person - name the concrete overlap.
gaps: 0-3 short things the ad asks for that the profile doesn't show, each with a hint how to cover it if there is one (e.g. "dbt - mention the SQL reporting pipelines from the last job").
german: the German level the ad needs, short ("C1 / fluent", "basic", "not needed"). hours: hours a week if stated, else "". start/deadline: as stated, else "". lang: the ad's language.
skills: up to 8 concrete skills/tools the ad asks for, short canonical names ("Power BI", "dbt", "TypeScript").
Never invent facts about the people.`;
};

async function ai(apiKey: string, model: string, system: string, user: string, json = true): Promise<string> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = (await r.json()) as any;
  return d?.choices?.[0]?.message?.content ?? "";
}

async function match(env: JobsEnv, j: Jobs, p: Record<string, Person>, row: JobRow, text: string, active: string[]): Promise<Facts> {
  const user =
    `Searching right now: ${active.map((w) => p[w].name.toUpperCase()).join(" and ")} only - never return anyone else.\n\n` +
    active.map((w) => `${p[w].name.toUpperCase()}: ${p[w].summary}\nSkills: ${p[w].skills.join(", ")}\n\n`).join("") +
    `=== JOB ===\nTitle: ${row.title}\nCompany: ${row.company}\nPlace: ${row.place}\nType: ${row.kind || "?"}\n\n` +
    text.slice(0, 1500);
  const d = JSON.parse(await ai(env.OPENAI_API_KEY, env.FINDS_MODEL || "gpt-5.6-luna", MATCH(j), user) || "{}");
  const arr = (x: unknown, n: number) => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, n) : []);
  // keep the answer to the people actually searching
  const all = everyone(j);
  let who: string = typeof d.for === "string" && (ids(j).includes(d.for) || (d.for === all && j.people.length > 1)) ? d.for : "none";
  if (who === all) who = active.length === 1 ? active[0] : active.length < j.people.length ? active.join(",") : all;
  if (single(j, who) && !active.includes(who)) who = "none";
  if (j.student_permit && d.kind === "full-time") { who = "none"; d.reason = "full-time"; }
  return {
    for: who,
    reason: String(d.reason ?? "").slice(0, 80), kind: String(d.kind ?? "other"),
    why: String(d.why ?? "").slice(0, 140), gaps: arr(d.gaps, 3).map((g) => g.slice(0, 110)),
    german: String(d.german ?? ""), hours: String(d.hours ?? ""), start: String(d.start ?? ""),
    deadline: String(d.deadline ?? ""), lang: d.lang === "en" ? "en" : "de", skills: arr(d.skills, 8),
  };
}

// ---------------------------------------------------------------- one tick
export async function jobsStep(env: JobsEnv, store: Store, tg: Telegram): Promise<string> {
  const db = env.DB;
  const cfg = await loadConfig(store);
  if (!cfg) return `jobs: ${NO_CONFIG}`;
  if (!cfg.modules.jobs) return "jobs: off";
  if ((await store.kvGet("jobs_on")) === "0") return "jobs: paused";
  if (!(await takeLock(db))) return "jobs: another run is still going";
  try {
    await ensureTable(db);
    const j = cfg.jobs;
    const names = (await activePeople(store, j)).map((w) => nameOf(j, w)).join(" & ");
    await introduce(cfg, store, tg, "jobs",
      `💼 <b>Jobs for ${esc(names)}</b> will be posted here: ${j.student_permit ? "Werkstudent jobs, internships and thesis positions" : "jobs"} ` +
      `in ${esc(where(j))}, each with who it fits, the gaps, and buttons to track the application.\n\n` +
      `/jobs - the board · /skills ${ids(j)[0]} - what it matches against · /cv - the CVs`);
    const did: string[] = [];
    did.push(await collect(db, store, cfg.jobs));
    did.push(await assess(env, store, tg, cfg.jobs));
    const redone = await repost(db, store, tg, cfg.jobs);
    if (redone) did.push(`${redone} taken down to re-post`);
    const posted = await post(env, store, tg, cfg);
    if (posted) did.push(`${posted} posted`);
    const gone = await recheck(env, store, tg, cfg);
    if (gone) did.push(`${gone} no longer listed`);
    const due = await remind(env, store, tg, cfg);
    if (due) did.push(`${due} reminders`);
    if (await weekly(env, store, tg, cfg)) did.push("weekly report");
    did.push(await nudgeStep(db, store, tg, cfg));
    return `jobs: ${did.filter(Boolean).join(", ")}`;
  } finally {
    await store.kvSet("jobs_lock", "0");
  }
}

async function collect(db: D1Database, store: Store, j: Jobs): Promise<string> {
  const found: Found[] = [];
  const out: string[] = [];
  const active = await activePeople(store, j);
  const searches = searchesFor(j, active);
  const i = Number((await store.kvGet("jobs_query")) ?? 0) % searches.length;
  for (let k = 0; k < QUERIES_PER_TICK; k++) {
    const q = searches[(i + k) % searches.length];
    try { const f = await fetchBA(q); found.push(...f); out.push(`"${q.q}" ${q.wo}`); await noteOk(store, "jobs_ba", f.length); }
    catch (e: any) { out.push(`${q.q}: ${e?.message ?? e}`); await noteError(store, "jobs_ba", e); }
  }
  await store.kvSet("jobs_query", String((i + QUERIES_PER_TICK) % searches.length));
  if (j.arbeitnow && now() - Number((await store.kvGet("jobs_arbeitnow_at")) ?? 0) >= ARBEITNOW_EVERY) {
    try {
      const f = await fetchArbeitnow(j); found.push(...f); out.push("Arbeitnow");
      await store.kvSet("jobs_arbeitnow_at", String(now())); await noteOk(store, "jobs_arbeitnow", f.length);
    } catch (e: any) { out.push(`Arbeitnow: ${e?.message ?? e}`); await noteError(store, "jobs_arbeitnow", e); }
  }
  if (!found.length) return out.join(" + ") + ": nothing";
  const { fresh, keep } = await saveFound(db, j, active, found);
  return `${out.join(" + ")}: ${found.length} found, ${fresh} new, ${keep} to match`;
}

/** The ids and same-job keys among these that are stored already. */
async function knownOf(db: D1Database, found: { id: string; company: string; title: string }[]): Promise<Set<string>> {
  const ids = [...new Set(found.map((f) => f.id))];
  const keys = [...new Set(found.map((f) => dedupeKey(f.company, f.title)))];
  const known = new Set<string>();
  for (let s = 0; s < ids.length; s += 50) {
    const a = ids.slice(s, s + 50), b = keys.slice(s, s + 50);
    const { results } = await db.prepare(
      `SELECT id, dkey FROM jobs WHERE id IN (${a.map(() => "?").join(",")}) OR dkey IN (${b.map(() => "?").join(",") || "''"})`)
      .bind(...a, ...b).all<{ id: string; dkey: string }>();
    for (const r of results ?? []) { known.add(r.id); known.add(r.dkey); }
  }
  return known;
}

/** Store the jobs not seen before: "new" to be matched, or "skipped" with the rule that left it out. */
async function saveFound(db: D1Database, j: Jobs, active: string[], found: Found[]): Promise<{ fresh: number; keep: number }> {
  const known = await knownOf(db, found);
  let fresh = 0, keep = 0;
  for (const f of found) {
    const dkey = dedupeKey(f.company, f.title);
    if (known.has(f.id) || known.has(dkey)) continue;
    known.add(f.id); known.add(dkey);
    fresh++;
    const why = jobRejectReason(f.title, j, active, f.kind);
    if (!why) keep++;
    await db.prepare(
      `INSERT OR IGNORE INTO jobs (id,dkey,source,title,company,place,url,remote,kind,text,status,why,first_seen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(f.id, dkey, f.source, f.title, f.company, f.place, f.url, f.remote ? 1 : 0, f.kind,
            f.text ? f.text.slice(0, 6000) : null, why ? "skipped" : "new", why, now()).run();
  }
  return { fresh, keep };
}

// ---------------------------------------------------------------- jobs from outside
/**
 * Jobs found somewhere the Worker can't fetch itself - LinkedIn refuses
 * Cloudflare, so a script on a home computer searches it
 * (scripts/linkedin.mjs) and hands the jobs in here:
 *   {op: "known", jobs: [{id, company, title}]}  -> {unknown: [id]}
 *   {op: "add", jobs: [Found]}                    -> {fresh, keep}
 * Added jobs go through the same rules, matching and cards as the rest.
 */
export async function ingestJobs(db: D1Database, store: Store, body: any): Promise<{ status: number; json: unknown }> {
  const cfg = await loadConfig(store);
  if (!cfg?.modules.jobs) return { status: 409, json: { error: "jobs are switched off" } };
  const list = Array.isArray(body?.jobs) ? body.jobs : null;
  const str = (x: unknown) => typeof x === "string";
  const ok = list && list.length <= 200 && list.every((f: any) => str(f?.id) && /^[a-z]{2}:/.test(f.id) && str(f.title) && str(f.company));
  if (!ok || !["known", "add"].includes(body?.op)) return { status: 400, json: { error: "expected {op: known|add, jobs: [{id, title, company, …}]}" } };
  await ensureTable(db);
  if (body.op === "known") {
    const known = await knownOf(db, list);
    return { status: 200, json: { unknown: list.filter((f: any) => !known.has(f.id) && !known.has(dedupeKey(f.company, f.title))).map((f: any) => f.id) } };
  }
  const found: Found[] = list.map((f: any) => ({
    id: f.id, source: String(f.source ?? "outside").slice(0, 30), title: f.title.slice(0, 300), company: f.company.slice(0, 200),
    place: String(f.place ?? "").slice(0, 200), url: String(f.url ?? "").slice(0, 500), remote: !!f.remote,
    kind: String(f.kind ?? "").slice(0, 100), text: f.text ? String(f.text).slice(0, 6000) : undefined,
  }));
  return { status: 200, json: await saveFound(db, cfg.jobs, await activePeople(store, cfg.jobs), found) };
}

async function assess(env: JobsEnv, store: Store, tg: Telegram, j: Jobs): Promise<string> {
  const db = env.DB;
  const { results } = await db.prepare(
    "SELECT * FROM jobs WHERE status='new' ORDER BY first_seen, rowid LIMIT ?").bind(ASSESS_PER_TICK).all<JobRow>();
  if (!results?.length) return "";
  const p = await people(store, j);
  const active = await activePeople(store, j);
  let ok = 0, none = 0;
  for (const row of results) {
    try {
      const text = row.text ?? (row.id.startsWith("ba:") ? await detailsBA(row.id) : "");
      const f = await match(env, j, p, row, text, active);
      await aiWorked(store);
      if (f.for === "none") { none++; await setJob(db, row.id, { status: "skipped", why: `ai: ${f.reason || "not a fit"}`, text: text.slice(0, 6000) }); continue; }
      ok++;
      await setJob(db, row.id, { status: "ready", person: f.for, kind: f.kind, facts: JSON.stringify(f), text: text.slice(0, 6000) });
    } catch (e: any) {
      if (/OpenAI/.test(String(e?.message))) await aiFailed(store, tg, e);
      const tries = row.attempts + 1;
      await setJob(db, row.id, tries >= MAX_ATTEMPTS ? { attempts: tries, status: "skipped", why: `failed: ${String(e?.message ?? e).slice(0, 60)}` } : { attempts: tries });
      console.error(`job match failed for ${row.id}:`, e?.message ?? e);
    }
  }
  return `matched ${ok}, not a fit ${none}`;
}

// ---------------------------------------------------------------- the card
const KIND: Record<string, string> = {
  werkstudent: "🎓 Werkstudent", internship: "📝 Internship", thesis: "📚 Thesis",
  "part-time": "⏱ Part-time", junior: "💼 Junior", other: "💼 Job",
};
const STATUS: Record<string, string> = {
  posted: "", approved: "🔖 On the waiting list", applied: "⏳ Waiting for an answer", already: "⏳ Waiting for an answer",
  interview: "🗓 Interview set", rejected: "❌ Rejected", offer: "🎉 Offer received", declined: "🙅 Offer declined",
  accepted: "🤝 Offer accepted", skipped: "⏭ Skipped", expired: "🚫 No longer listed",
};
/** The tracker's statuses, in order, with the button that sets each. */
const TRACK: [string, string, string][] = [
  ["wait", "applied", "⏳ Waiting"], ["rej", "rejected", "❌ Rejected"], ["int", "interview", "🗓 Interview set"],
  ["off", "offer", "🎉 Offer received"], ["dec", "declined", "🙅 Offer declined"], ["acc", "accepted", "🤝 Offer accepted"],
];
const TRACKED = ["applied", "already", "interview", "rejected", "offer", "declined", "accepted"];
/** A table row in <pre>: the label padded by what's seen (an emoji is one), then the number. */
const rowOf = (label: string, n: number, width = 20) => `${label}${" ".repeat(Math.max(2, width - [...label].length))}${n}`;

const forWhom = (j: Jobs, person: string | null) => {
  const one = single(j, person);
  if (one) return `${byId(j, one)!.icon} For ${byId(j, one)!.name}`;
  const ps = peopleOf(j, person);
  return ps.length ? `👥 For ${ps.map((x) => nameOf(j, x)).join(" & ")}` : "";
};

export function card(row: JobRow, j: Jobs): string {
  const f: Partial<Facts> = row.facts ? JSON.parse(row.facts) : {};
  const st = STATUS[row.status] ?? "";
  const by = single(j, row.person) && (row.applied_at || row.approved_at) && row.status !== "posted" ? ` by ${nameOf(j, row.person!)}` : "";
  const when = row.replied_at ?? row.applied_at ?? row.approved_at;
  // one section per thing, a blank line between: what and where, who it's
  // for, why, the requirements (one per line), the gaps, the link, the status
  const sections = [
    [`💼 <b>${esc(row.title)}</b>`, `🏢 ${esc(row.company)}`, `📍 ${[row.place ? esc(row.place) : "", `via ${esc(row.source)}`].filter(Boolean).join(" · ")}`].join("\n"),
    [forWhom(j, row.person), KIND[f.kind ?? "other"] ?? KIND.other].filter(Boolean).join(" · "),
    f.why ? `<i>${esc(f.why)}</i>` : "",
    [f.german ? `🗣 German: ${esc(f.german)}` : "", f.hours ? `⏱ Hours: ${esc(f.hours)}` : "",
      f.start ? `📅 Start: ${esc(f.start)}` : "", f.deadline ? `⏳ Apply by: ${esc(f.deadline)}` : ""].filter(Boolean).join("\n"),
    f.gaps?.length ? `⚠️ <b>Gaps</b>\n${f.gaps.map((g) => `• ${esc(g)}`).join("\n")}` : "",
    `🔗 <a href="${esc(row.url)}">Open the job</a>`,
    st ? `<b>${st}${by}${when ? ` · ${day(when)}` : ""}</b>` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

// Telegram allows 64 bytes of data on a button, and Arbeitnow's ids can be
// longer. Such a job goes by the end of its id ("~…-283450", which is what
// makes it unique), and jobButton looks it up that way.
const BUTTON_BYTES = 64;
const buttonData = (act: string, who: string | null, id: string) => {
  const head = `jb:${act}:${who}:`;
  const room = BUTTON_BYTES - new TextEncoder().encode(head).length;
  return id.length <= room ? head + id : `${head}~${id.slice(-(room - 1))}`;
};

/** The buttons for where the application is now. */
export function jobKeyboard(row: JobRow, j: Jobs): Button[][] {
  const id = row.id;
  // a card for several people gets one button each
  const many = single(j, row.person) ? [] : peopleOf(j, row.person);
  const each = (a: string, label: string) => many.length
    ? many.map((w) => ({ text: `${label} (${nameOf(j, w)})`, callback_data: buttonData(a, w, id) }))
    : [{ text: label, callback_data: buttonData(a, row.person, id) }];
  const skip = { text: "⏭ Skip", callback_data: buttonData("skip", "-", id) };
  if (row.status === "posted")
    return [each("letter", "✍️ Cover letter"), [...each("applied", "✅ Applied"), ...each("already", "🔁 Already applied")],
      [...each("later", "🔖 Apply later"), skip]];
  if (row.status === "approved")
    return [each("letter", "✍️ Cover letter"), [...each("applied", "✅ Applied"), ...each("already", "🔁 Already applied")], [skip]];
  if (TRACKED.includes(row.status)) {
    const now = row.status === "already" ? "applied" : row.status;
    const b = TRACK.map(([code, st, label]) => ({ text: st === now ? `• ${label} •` : label, callback_data: buttonData(`t${code}`, "-", id) }));
    return [b.slice(0, 2), b.slice(2, 4), b.slice(4, 6)];
  }
  return [];
}

/** A job in the tracker: short, with its status and the buttons to change it. */
export function trackerCard(row: JobRow, j: Jobs, note = ""): string {
  const who = single(j, row.person) ? `${byId(j, row.person!)!.icon} ${nameOf(j, row.person!)}` : forWhom(j, row.person);
  return [
    note,
    [`📋 <b>${esc(row.title)}</b>`, `🏢 ${esc(row.company)}${row.place ? ` · 📍 ${esc(row.place)}` : ""}`].join("\n"),
    [who, row.applied_at ? `applied ${day(row.applied_at)}` : "", row.replied_at && row.status !== "applied" && row.status !== "already" ? `updated ${day(row.replied_at)}` : ""]
      .filter(Boolean).join(" · "),
    `Status: <b>${STATUS[row.status] ?? row.status}</b>`,
    `🔗 <a href="${esc(row.url)}">Open the job</a>`,
  ].filter(Boolean).join("\n\n");
}

const topic = async (cfg: Config, store: Store, tg: Telegram) => inTopic(await topicOf(cfg, store, tg, "jobs"));

async function post(env: JobsEnv, store: Store, tg: Telegram, cfg: Config): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare(
    "SELECT * FROM jobs WHERE status='ready' ORDER BY first_seen, rowid LIMIT ?").bind(POST_PER_TICK).all<JobRow>();
  let n = 0;
  for (const row of results ?? []) {
    const shown = { ...row, status: "posted" };
    try {
      const r = await tg.send(card(shown, cfg.jobs), { ...tg.keyboard(jobKeyboard(shown, cfg.jobs)), ...(await topic(cfg, store, tg)) });
      await setJob(db, row.id, { status: "posted", posted_at: now(), msg_id: r?.result?.message_id ?? null });
      n++;
    } catch (e: any) {
      if (String(e?.message).includes(" 429")) break;
      const tries = row.attempts + 1;
      await setJob(db, row.id, tries >= MAX_ATTEMPTS
        ? { attempts: tries, status: "skipped", why: `could not post: ${String(e?.message ?? e).slice(0, 120)}` } : { attempts: tries });
      console.error(`job post failed for ${row.id}:`, e?.message ?? e);
    }
  }
  return n;
}

/**
 * kv jobs_repost=1: delete the cards nobody has pressed a button on yet and
 * post them again (in the current layout). jobs_repost=recheck: the same, but
 * they go through the rules and the AI again first (after a rule change).
 * Runs once, then clears the flag.
 */
async function repost(db: D1Database, store: Store, tg: Telegram, j: Jobs): Promise<number> {
  const mode = await store.kvGet("jobs_repost");
  if (mode !== "1" && mode !== "recheck" && mode !== "all") return 0;
  await store.kvSet("jobs_repost", "0");
  // all: every job message the bot knows of comes down (tracked ones stay
  // tracked, in /jobs); the open ones go out again in the current layout
  if (mode === "all") {
    const { results } = await db.prepare("SELECT id, status, msg_id FROM jobs WHERE msg_id IS NOT NULL").all<{ id: string; status: string; msg_id: number }>();
    let stuck = 0;
    for (const r of results ?? []) {
      try { await tg.deleteMessage(r.msg_id); } catch { stuck++; }
      await setJob(db, r.id, r.status === "posted" ? { status: "ready", msg_id: null } : { msg_id: null });
    }
    await store.kvSet("jobs_repost_stuck", String(stuck));
    return results?.length ?? 0;
  }
  const active = await activePeople(store, j);
  const { results } = await db.prepare("SELECT id, msg_id, title, kind FROM jobs WHERE status='posted'")
    .all<{ id: string; msg_id: number | null; title: string; kind: string | null }>();
  for (const r of results ?? []) {
    if (r.msg_id) try { await tg.deleteMessage(r.msg_id); } catch { /* already gone or too old */ }
    const why = mode === "recheck" ? jobRejectReason(r.title, j, active, r.kind ?? "") : null;
    await setJob(db, r.id, mode === "1" ? { status: "ready", msg_id: null }
      : why ? { status: "skipped", why, msg_id: null } : { status: "new", attempts: 0, msg_id: null });
  }
  return results?.length ?? 0;
}

/**
 * Without AI: a posted job nobody has acted on is looked up again 3 days
 * after it went out, then every 3 days, two per tick. Taken down at the
 * Jobbörse (404) or Arbeitnow: the card says "No longer listed" and loses its
 * buttons, and it no longer counts as open. LinkedIn can't be reached from
 * here; those stay as they are.
 */
const RECHECK_AFTER = 3 * 86400;
async function recheck(env: JobsEnv, store: Store, tg: Telegram, cfg: Config): Promise<number> {
  const db = env.DB;
  const t = now();
  const { results } = await db.prepare(
    `SELECT * FROM jobs WHERE status IN ('posted','approved') AND (id LIKE 'ba:%' OR id LIKE 'an:%') AND posted_at < ? AND COALESCE(checked_at, 0) < ?
     ORDER BY COALESCE(checked_at, posted_at) LIMIT 2`).bind(t - RECHECK_AFTER, t - RECHECK_AFTER).all<JobRow>();
  let gone = 0;
  for (const row of results ?? []) {
    const url = row.id.startsWith("ba:")
      ? `${BA}/pc/v4/jobdetails/${btoa(String.fromCharCode(...new TextEncoder().encode(row.id.slice(3))))}` : row.url;
    let status = 0;
    try { status = (await fetch(url, row.id.startsWith("ba:") ? { headers: BA_KEY } : { redirect: "manual" })).status; } catch { /* try again later */ }
    if (status !== 404 && status !== 410) { if (status) await setJob(db, row.id, { checked_at: t }); continue; }
    const expired = { ...row, status: "expired" };
    await setJob(db, row.id, { status: "expired", checked_at: t, msg_id: null });
    if (row.msg_id) try { await tg.deleteMessage(row.msg_id); }
    catch { try { await tg.editText(tg.chat, row.msg_id, card(expired, cfg.jobs), []); } catch { /* gone already */ } }
    gone++;
  }
  return gone;
}

async function remind(env: JobsEnv, store: Store, tg: Telegram, cfg: Config): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM jobs WHERE status IN ('applied','already') AND reminded=0 AND applied_at < ? LIMIT 3`)
    .bind(now() - FOLLOW_UP_DAYS * 86400).all<JobRow>();
  for (const row of results ?? []) {
    await tg.send(trackerCard(row, cfg.jobs, `⏰ <b>No answer after ${FOLLOW_UP_DAYS} days</b> - a short follow-up email often helps, or set the status below.`),
      { ...tg.keyboard(jobKeyboard(row, cfg.jobs)), ...(await topic(cfg, store, tg)) });
    await setJob(db, row.id, { reminded: 1 });
  }
  return results?.length ?? 0;
}

// ---------------------------------------------------------------- buttons
/** jb:<action>:<who|->:<id> - pressed by anyone in the group. */
export async function jobButton(env: JobsEnv, store: Store, tg: Telegram, cq: any): Promise<void> {
  const db = env.DB;
  const cfg = await loadConfig(store);
  if (!cfg?.modules.jobs) { await tg.answerCallback(cq.id, cfg ? "Jobs are switched off" : NO_CONFIG); return; }
  const j = cfg.jobs;
  await ensureTable(db);
  const [, raw, who, ...rest] = String(cq.data).split(":");
  // buttons on cards from before the tracker still work
  const act = ({ interview: "tint", rejected: "trej", offer: "toff", approve: "later" } as Record<string, string>)[raw] ?? raw;
  const ref = rest.join(":");
  // jb:list:<waiting|tracker>:- - the board's buttons: the same as the commands
  if (act === "csv") { await tg.answerCallback(cq.id, "Making the CSV…"); await sendTrackerCsv(db, store, tg, cfg); return; }
  if (act === "list") {
    await tg.answerCallback(cq.id);
    await (who === "tracker" ? sendTracker : sendWaitingList)(db, store, tg, cfg);
    return;
  }
  // "~…": the end of a long id (see buttonData)
  const row = ref.startsWith("~")
    ? await db.prepare("SELECT * FROM jobs WHERE substr(id, -?) = ?").bind(ref.length - 1, ref.slice(1)).first<JobRow>()
    : await db.prepare("SELECT * FROM jobs WHERE id=?").bind(ref).first<JobRow>();
  if (!row) { await tg.answerCallback(cq.id, "Unknown job"); return; }
  const id = row.id;

  if (act === "letter") {
    await tg.answerCallback(cq.id, "Writing the cover letter…");
    const w = byId(j, who) ? who : ids(j)[0];
    const where = await topic(cfg, store, tg);
    try {
      const letter = await coverLetter(env, store, row, w, j);
      const r = await tg.send(`✍️ <b>Cover letter for ${nameOf(j, w)}</b> - ${esc(row.company)}\n\n<pre>${esc(letter)}</pre>`,
        { ...where, ...(cq.message?.message_id ? { reply_to_message_id: cq.message.message_id } : {}) });
      const cv = await store.kvGet(`jobs_cv:${w}`);
      if (cv) await tg.sendDocument(cv, { ...where, reply_to_message_id: r?.result?.message_id, caption: `📎 ${nameOf(j, w)}'s CV` });
    } catch (e: any) {
      await aiFailed(store, tg, e);
      await tg.send("Couldn't write it right now - try the button again in a bit.", where);
    }
    return;
  }

  const t = now();
  const chat = cq.message?.chat?.id, msg = cq.message?.message_id;
  const edit = async (text: string, kb: Button[][]) => { try { await tg.editText(chat, msg, text, kb); } catch { /* unchanged */ } };
  const undoBtn = [[{ text: "↩️ Undo", callback_data: buttonData("undo", "-", id) }]];
  const what = `ad for <b>${esc(row.title)}</b> at <b>${esc(row.company)}</b>`;

  // tracker statuses: the message changes in place
  const track = TRACK.find(([code]) => act === `t${code}`);
  if (track) {
    const st = track[1];
    await setJob(db, id, { status: st, replied_at: st === "applied" ? null : t });
    const updated = { ...row, status: st, replied_at: st === "applied" ? null : t } as JobRow;
    await tg.answerCallback(cq.id, STATUS[st]);
    await edit(trackerCard(updated, j), jobKeyboard(updated, j));
    return;
  }

  // ↩️ Undo: back to where it was, the full card again
  if (act === "undo") {
    const was: { status?: string; person?: string | null } = row.was ? JSON.parse(row.was) : {};
    if (!was.status) { await tg.answerCallback(cq.id, "Nothing to undo"); return; }
    const back = { status: was.status, person: was.person ?? row.person, was: null,
      ...(TRACKED.includes(row.status) && !TRACKED.includes(was.status) ? { applied_at: null } : {}),
      ...(row.status === "approved" && was.status !== "approved" ? { approved_at: null } : {}),
      ...(row.status === "skipped" ? { why: null } : {}) };
    await setJob(db, id, back);
    const updated = { ...row, ...back } as JobRow;
    await tg.answerCallback(cq.id, "↩️ Undone");
    await edit(card(updated, j), jobKeyboard(updated, j));
    return;
  }

  // skip, applied, already applied, apply later: the card turns into one line with an Undo
  const moves: Record<string, [Record<string, unknown>, string]> = {
    skip: [{ status: "skipped", why: "skipped by you" }, `⏭ The ${what} skipped.`],
    applied: [{ status: "applied", applied_at: t, replied_at: null, person: who }, `✅ The ${what} moved to the tracker${byId(j, who) ? ` (applied by ${nameOf(j, who)})` : ""}.\n<i>/tracker - all of them</i>`],
    already: [{ status: "already", applied_at: t, replied_at: null, person: who }, `🔁 The ${what} moved to the tracker${byId(j, who) ? ` (${nameOf(j, who)} applied before)` : ""}.\n<i>/tracker - all of them</i>`],
    later: [{ status: "approved", approved_at: t, person: who }, `🔖 The ${what} moved to the waiting list${byId(j, who) ? ` (for ${nameOf(j, who)})` : ""}.\n<i>/waitinglist - all of them</i>`],
  };
  const m = moves[act];
  if (!m) { await tg.answerCallback(cq.id); return; }
  await setJob(db, id, { ...m[0], was: JSON.stringify({ status: row.status, person: row.person }) });
  await tg.answerCallback(cq.id, { skip: "⏭ Skipped", applied: "✅ Moved to the tracker", already: "🔁 Moved to the tracker", later: "🔖 Moved to the waiting list" }[act]);
  await edit(m[1].replace("The ad for", "Ad for"), undoBtn);
}

/** /waitinglist: every ad on the waiting list, as its card - ready to apply. */
export async function sendWaitingList(db: D1Database, store: Store, tg: Telegram, cfg: Config): Promise<void> {
  await ensureTable(db);
  const { results } = await db.prepare("SELECT * FROM jobs WHERE status='approved' ORDER BY approved_at LIMIT 20").all<JobRow>();
  const where = await topic(cfg, store, tg);
  const rows = results ?? [];
  await tg.send(rows.length ? `🔖 <b>Waiting list</b> · ${rows.length} ad${rows.length > 1 ? "s" : ""} to apply to` : "🔖 <b>Waiting list</b>\n\nNothing on it. 🔖 Apply later on a job card puts it here.", where);
  for (const r of rows) {
    const sent = await tg.send(card(r, cfg.jobs), { ...tg.keyboard(jobKeyboard(r, cfg.jobs)), ...where });
    await setJob(db, r.id, { msg_id: sent?.result?.message_id ?? null });
  }
}

// ---------------------------------------------------------------- the tracker as a spreadsheet
/** "remote", "hybrid" or "on-site", from the listing's remote flag, its place and text. */
export function workMode(row: Pick<JobRow, "remote" | "place" | "text" | "title">): string {
  const t = `${row.place ?? ""} ${row.title ?? ""} ${row.text ?? ""}`.toLowerCase();
  if (/hybrid|home ?office|homeoffice|mobiles? arbeit|teilweise remote|remote[- ]anteil|\d+ ?tage? (remote|home)/.test(t)) return "hybrid";
  if (row.remote || /\bremote\b|100 ?% remote|fully remote|vollständig remote/.test(t)) return "remote";
  return "on-site";
}
/**
 * German, from what the AI read in the ad (it comes with the match, no extra
 * call) or else from the ad's text: [required?, level]. "not stated" when
 * neither says - a LinkedIn job has only its title.
 */
export function germanOf(german: string | undefined, text = ""): [string, string] {
  const g = (german ?? "").trim();
  if (/not (required|needed)|^none$|^no\b|nicht (erforderlich|notwendig)|english only|optional|nice to have|von vorteil|^plus$/i.test(g)) return ["no", ""];
  const level = (s: string) => /\b([ABC][12])\b/i.exec(s)?.[1]?.toUpperCase()
    ?? (/native|mutterspr/i.test(s) ? "native" : /fluent|fließend|verhandlungssicher|sehr gut|excellent/i.test(s) ? "fluent (C1+)"
      : /good|gut/i.test(s) ? "good (B2)" : /basic|grund/i.test(s) ? "basic (A2-B1)" : "");
  if (g && !/not (stated|mentioned)|unknown|unclear/i.test(g)) return ["yes", level(g) || g.slice(0, 40)];
  // the ad's own words: "sehr gute Deutschkenntnisse", "German (C1)", "fließend Deutsch"
  const m = /[^.\n]{0,60}(deutschkenntnisse|deutsch(?:e|en)? sprach|german (?:skills|language|is required|proficiency)|fließend(?:es)? deutsch|deutsch (?:in wort und schrift|fließend|auf [abc][12])|\bgerman\b[^.\n]{0,20}\b[abc][12]\b|\bdeutsch\b[^.\n]{0,20}\b[abc][12]\b)[^.\n]{0,40}/i.exec(text);
  if (m) return /von vorteil|wünschenswert|nice to have|a plus|ein plus|optional/i.test(m[0]) ? ["no", ""] : ["yes", level(m[0]) || "stated, no level"];
  return ["not stated", ""];
}
/**
 * Every application in the tracker, one row each. "Career-centered": a role
 * in the person's own field that builds the career - Werkstudent, internship,
 * thesis or junior (the AI's kind) with an on-topic title; "general": a
 * part-time or other job on the side.
 */
/** A role in the person's own field that builds the career: Werkstudent, internship, thesis or junior, with an on-topic title. */
export function isCareer(r: Pick<JobRow, "person" | "title" | "facts" | "kind">, j: Jobs): boolean {
  const f: Partial<Facts> = r.facts ? JSON.parse(r.facts) : {};
  const ps = peopleOf(j, r.person).map((w) => byId(j, w)).filter(Boolean) as Person[];
  return ps.some((p) => topicRx(p).test(r.title.toLowerCase())) && ["werkstudent", "internship", "thesis", "junior"].includes(f.kind ?? r.kind ?? "");
}
export function trackerRows(rows: JobRow[], j: Jobs): string[][] {
  const field = (r: JobRow) => (isCareer(r, j) ? "career-centered" : "general");
  return rows.map((r) => {
    const f: Partial<Facts> = r.facts ? JSON.parse(r.facts) : {};
    const [need, lvl] = germanOf(f.german, r.text ?? "");
    const city = (r.place ?? "").split(/[,·(]/)[0].trim();
    return [r.title, r.company, city, workMode(r), (STATUS[r.status] ?? r.status).replace(/^\S+\s/, ""), field(r), need, lvl];
  });
}
const HEAD: { title: string; fill: string; width: number }[] = [
  { title: "Title", fill: "BFDBFE", width: 44 }, { title: "Company", fill: "C7D2FE", width: 26 },
  { title: "City", fill: "BBF7D0", width: 14 }, { title: "Remote / hybrid / on-site", fill: "A7F3D0", width: 22 },
  { title: "Status", fill: "FDE68A", width: 22 }, { title: "General or career-centered", fill: "FBCFE8", width: 24 },
  { title: "German required", fill: "FED7AA", width: 16 }, { title: "German level", fill: "FECACA", width: 16 },
];
/** Each status its own light colour, so the column reads at a glance. */
const STATUS_FILL: Record<string, string> = {
  "Waiting for an answer": "FEF9C3", "Interview set": "DBEAFE", "Offer received": "DCFCE7", "Offer accepted": "BBF7D0",
  "Offer declined": "F3F4F6", "Rejected": "FEE2E2",
};
export const trackerXlsx = (rows: JobRow[], j: Jobs) => xlsx({ name: "Tracker", head: HEAD, rows: trackerRows(rows, j),
  cellFill: (_r, c, v) => (c === 4 ? STATUS_FILL[v] : undefined) });
const csvCell = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** The same as plain CSV (no colours: a CSV can't hold them). */
export const trackerCsv = (rows: JobRow[], j: Jobs) =>
  "\ufeff" + [HEAD.map((h) => h.title), ...trackerRows(rows, j)].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
export async function sendTrackerCsv(db: D1Database, store: Store, tg: Telegram, cfg: Config): Promise<void> {
  await ensureTable(db);
  const { results } = await db.prepare(
    `SELECT * FROM jobs WHERE status IN (${TRACKED.map(() => "?").join(",")}) ORDER BY COALESCE(applied_at, posted_at)`).bind(...TRACKED).all<JobRow>();
  const where = await topic(cfg, store, tg);
  if (!results?.length) { await tg.send("📋 Nothing in the tracker yet - no CSV to make.", where); return; }
  await tg.sendFile(`tracker-${new Date(Date.now()).toISOString().slice(0, 10)}.xlsx`, trackerXlsx(results, cfg.jobs),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    { ...where, caption: `📥 Tracker · ${results.length} application${results.length > 1 ? "s" : ""}` });
}

/** /tracker: the counts, then every application with its status and the buttons to change it. */
export async function sendTracker(db: D1Database, store: Store, tg: Telegram, cfg: Config): Promise<void> {
  await ensureTable(db);
  const { results } = await db.prepare(
    `SELECT * FROM jobs WHERE status IN (${TRACKED.map(() => "?").join(",")}) ORDER BY COALESCE(replied_at, applied_at) DESC LIMIT 25`)
    .bind(...TRACKED).all<JobRow>();
  const rows = results ?? [];
  const where = await topic(cfg, store, tg);
  if (!rows.length) { await tg.send("📋 <b>Tracker</b>\n\nNothing in it yet. ✅ Applied on a job card puts it here.", where); return; }
  const n = (st: string[]) => rows.filter((r) => st.includes(r.status)).length;
  await tg.send(`📋 <b>Tracker</b> · ${rows.length} application${rows.length > 1 ? "s" : ""}\n\n<pre>` + [
    ["⏳ Waiting", n(["applied", "already"])], ["🗓 Interview set", n(["interview"])], ["🎉 Offer received", n(["offer"])],
    ["🤝 Offer accepted", n(["accepted"])], ["🙅 Offer declined", n(["declined"])], ["❌ Rejected", n(["rejected"])],
  ].map(([l, c]) => rowOf(String(l), Number(c))).join("\n") + "</pre>",
    { ...where, ...tg.keyboard([[{ text: "📥 Download as Excel", callback_data: "jb:csv:-:-" }]]) });
  for (const r of rows) await tg.send(trackerCard(r, cfg.jobs), { ...tg.keyboard(jobKeyboard(r, cfg.jobs)), ...where });
}

// Words that make a letter read as machine-written (or as a template) in either language.
const STOCK = `passionate, excited, thrilled, eager, dynamic, innovative, cutting-edge, leverage, delve, foster, align, synergy, ` +
  `seamless, robust, journey, landscape, tapestry, "I am confident", "I am writing to", "furthermore", "moreover", "in today's", ` +
  `"hiermit bewerbe ich mich", "mit großem Interesse", "begeistert", "leidenschaftlich", "hochmotiviert", "spannende Herausforderung", ` +
  `"Teamplayer", "zielorientiert", "Mehrwert", "innovativ", "dynamisch", "Ihr renommiertes Unternehmen", "abgerundet"`;

async function coverLetter(env: JobsEnv, store: Store, row: JobRow, w: string, j: Jobs): Promise<string> {
  const p = await people(store, j);
  const f: Partial<Facts> = row.facts ? JSON.parse(row.facts) : {};
  const lang = f.lang === "en" ? "English" : "German";
  const sys = `Write a short cover letter for ${p[w].name} in ${lang}${lang === "German" ? ` (an Anschreiben, "Sie")` : ""}. It should read like ${p[w].name} wrote it in twenty minutes: plain, direct, a bit personal - not like a template and not like AI.

- 120-170 words, body only (no address block, no date, no subject line), ending with a greeting and the name ${p[w].full_name}.
- The first sentence names something specific from this ad - the product, the team, the project, a tool or task they mention - so it's clear the ad was actually read. No generic praise of the company.
- Then 2 concrete matches between what the ad asks for and what the CV shows (a project, a tool, a number from the CV). Only facts from the CV - never invent experience, tools or numbers.
- One sentence on availability: ${p[w].availability}.
- Short, everyday words and short sentences. Vary sentence length. No em dashes, no lists, no rhetorical questions, no exaggeration.
- Never use these: ${STOCK}.`;
  const user = `=== CV ===\n${p[w].cv}\n\n=== JOB ===\nTitle: ${row.title}\nCompany: ${row.company}\nPlace: ${row.place}\n\n${(row.text ?? "").slice(0, 3000)}`;
  const out = await ai(env.OPENAI_API_KEY, env.OPENAI_MODEL, sys, user, false);
  await aiWorked(store);
  return out.trim().replace(/\s*[—–]\s*/g, " - ");
}

// ---------------------------------------------------------------- /jobs, /skills
const DONE = TRACKED;
/** "Berlin, Cottbus, remote" */
const where = (j: Jobs) => [...j.cities.map((c) => c.name), ...(j.remote ? ["remote"] : [])].join(", ");

/**
 * /jobs: per person, where everything stands, as a table; then buttons for
 * the waiting list and the tracker (the same as /waitinglist and /tracker).
 */
export async function jobsBoard(db: D1Database, store: Store): Promise<[string, Button[][]]> {
  const cfg = await loadConfig(store);
  if (!cfg) return [NO_CONFIG, []];
  if (!cfg.modules.jobs) return ["💼 Jobs are switched off in the config.", []];
  const j = cfg.jobs;
  await ensureTable(db);
  const { results } = await db.prepare(
    `SELECT person, status, COUNT(*) n FROM jobs WHERE status IN ('posted','approved',${TRACKED.map((x) => `'${x}'`).join(",")})
     GROUP BY person, status`).all<{ person: string; status: string; n: number }>();
  const by: Record<string, Record<string, number>> = {};
  const total: Record<string, number> = {};
  for (const r of results ?? []) {
    total[r.status] = (total[r.status] ?? 0) + r.n;
    for (const p of peopleOf(j, r.person)) (by[p] ??= {})[r.status] = (by[p][r.status] ?? 0) + r.n;
  }
  const table = (s: Record<string, number>) => {
    const c = (...k: string[]) => k.reduce((a, x) => a + (s[x] ?? 0), 0);
    const rows: [string, number][] = [
      ["🆕 New", c("posted")], ["🔖 Waiting list", c("approved")], ["📋 Tracker", c(...TRACKED)],
      ["   ⏳ Waiting", c("applied", "already")], ["   🗓 Interview set", c("interview")], ["   🎉 Offer received", c("offer")],
      ["   🤝 Accepted", c("accepted")], ["   🙅 Declined", c("declined")], ["   ❌ Rejected", c("rejected")],
    ];
    return `<pre>${rows.map(([l, n]) => rowOf(l, n, 22)).join("\n")}</pre>`;
  };
  const active = await activePeople(store, j);
  const text = [`💼 <b>Jobs</b>\n<i>${esc(where(j))}</i>`,
    ...active.map((w) => `${byId(j, w)!.icon} <b>${nameOf(j, w)}</b>\n${table(by[w] ?? {})}`),
    `<i>/waitinglist · /tracker · /cv · /skills ${active[0]}</i>`].join("\n\n");
  return [text, [[
    { text: `🔖 Waiting list (${total.approved ?? 0})`, callback_data: "jb:list:waiting:-" },
    { text: `📋 Tracker (${TRACKED.reduce((a, x) => a + (total[x] ?? 0), 0)})`, callback_data: "jb:list:tracker:-" },
  ]]];
}

/** /skills diba · /skills diba + Power BI · /skills arman - Vue */
export async function skillsCommand(store: Store, args: string[]): Promise<string> {
  const cfg = await loadConfig(store);
  if (!cfg) return NO_CONFIG;
  if (!cfg.modules.jobs) return "💼 Jobs are switched off in the config.";
  const j = cfg.jobs;
  const w = (args[0] ?? "").toLowerCase();
  const [a, b = a] = ids(j);
  if (!ids(j).includes(w)) return `Try /skills ${a}, /skills ${a} + Power BI, /skills ${b} - Vue`;
  const p = await people(store, j);
  let list = p[w].skills;
  const op = args[1], skill = args.slice(2).join(" ").trim();
  if ((op === "+" || op === "-") && skill) {
    list = op === "+" ? [...list.filter((s) => s.toLowerCase() !== skill.toLowerCase()), skill]
      : list.filter((s) => s.toLowerCase() !== skill.toLowerCase());
    await store.kvSet(`jobs_skills:${w}`, JSON.stringify(list));
  }
  return `${p[w].icon} <b>${p[w].name}'s skills</b> (what jobs are matched against):\n${esc(list.join(", "))}`;
}

/**
 * /cv - send the saved CVs. To save one: send the PDF in the chat and answer
 * it with /cv diba (or send it with /cv diba as the caption).
 */
export async function cvCommand(store: Store, tg: Telegram, msg: any, args: string[], where: Record<string, unknown>): Promise<void> {
  const chat = String(msg.chat.id);
  const cfg = await loadConfig(store);
  if (!cfg?.modules.jobs) { await tg.send(cfg ? "💼 Jobs are switched off in the config." : NO_CONFIG, where, chat); return; }
  const j = cfg.jobs;
  const w = (args[0] ?? "").toLowerCase();
  const doc = msg.document ?? msg.reply_to_message?.document;
  if (doc) {
    if (!ids(j).includes(w)) { await tg.send(`Whose CV is it? Answer the PDF with ${ids(j).map((x) => `/cv ${x}`).join(" or ")}.`, where, chat); return; }
    await store.kvSet(`jobs_cv:${w}`, doc.file_id);
    await tg.send(`📎 Saved as ${nameOf(j, w)}'s CV - /cv sends it, and it comes with every cover letter.`, where, chat);
    return;
  }
  const whom = ids(j).includes(w) ? [w] : await activePeople(store, j);
  let sent = 0;
  for (const p of whom) {
    const id = await store.kvGet(`jobs_cv:${p}`);
    if (id) { await tg.sendDocument(id, { ...where, caption: `📎 ${nameOf(j, p)}'s CV` }, chat); sent++; }
  }
  if (!sent) await tg.send(`No CV saved yet. Send the PDF here, then answer it with /cv ${whom[0]}.`, where, chat);
}

// ---------------------------------------------------------------- weekly report
async function weekly(env: JobsEnv, store: Store, tg: Telegram, cfg: Config): Promise<boolean> {
  const d = new Date();
  if (d.getUTCDay() !== 1 || d.getUTCHours() < 7) return false;          // Mondays from 07:00 UTC
  const week = d.toISOString().slice(0, 10);
  if ((await store.kvGet("jobs_weekly")) === week) return false;
  await store.kvSet("jobs_weekly", week);
  const text = await weeklyReport(env.DB, store);
  if (text) await tg.send(text, await topic(cfg, store, tg));
  return true;
}

export async function weeklyReport(db: D1Database, store: Store): Promise<string> {
  const cfg = await loadConfig(store);
  if (!cfg) return NO_CONFIG;
  if (!cfg.modules.jobs) return "💼 Jobs are switched off in the config.";
  const j = cfg.jobs;
  await ensureTable(db);
  const p = await people(store, j);
  const weekAgo = now() - 7 * 86400;
  const { results } = await db.prepare(
    `SELECT * FROM jobs WHERE person IS NOT NULL AND status NOT IN ('new','ready','skipped')`).all<JobRow>();
  const rows = results ?? [];
  const parts: string[] = ["📊 <b>Jobs - weekly report</b>"];
  for (const w of await activePeople(store, j)) {
    const mine = rows.filter((r) => peopleOf(j, r.person).includes(w));
    const fx = (r: JobRow): Partial<Facts> => (r.facts ? JSON.parse(r.facts) : {});
    const newThisWeek = mine.filter((r) => (r.posted_at ?? 0) > weekAgo);
    const applied = mine.filter((r) => DONE.includes(r.status) && r.person === w);
    const answered = (rs: JobRow[]) => rs.filter((r) => ["interview", "rejected", "offer"].includes(r.status)).length;
    const positive = (rs: JobRow[]) => rs.filter((r) => ["interview", "offer"].includes(r.status)).length;
    const lines: string[] = [];
    const city = (c: string) => newThisWeek.filter((r) => (c === "remote" ? r.remote : r.place.toLowerCase().includes(c))).length;
    const per = [...j.cities.map((c) => `${c.name} ${city(c.name.toLowerCase())}`), ...(j.remote ? [`remote ${city("remote")}`] : [])];
    lines.push(`New matches this week: ${newThisWeek.length} (${per.join(", ")})`);
    if (applied.length) {
      lines.push(`Applied so far: ${applied.length} · answers ${answered(applied)} · interviews or offers ${positive(applied)}`);
      // which kind of job gets answers
      const groups = new Map<string, JobRow[]>();
      for (const r of applied) {
        const k = `${fx(r).kind ?? "other"}, ${fx(r).lang === "en" ? "English" : "German"} ad, via ${r.source}`;
        groups.set(k, [...(groups.get(k) ?? []), r]);
      }
      for (const [k, rs] of [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 4))
        lines.push(`  ${k}: ${positive(rs)} interviews from ${rs.length}`);
    }
    // what's due
    const followUps = applied.filter((r) => ["applied", "already"].includes(r.status) && (r.applied_at ?? now()) < now() - FOLLOW_UP_DAYS * 86400);
    if (followUps.length) lines.push(`Follow up: ${followUps.map((r) => esc(r.company)).slice(0, 5).join(", ")}`);
    const open = mine.filter((r) => r.status === "posted" && fx(r).deadline);
    if (open.length) lines.push(`Open with a deadline: ${open.slice(0, 4).map((r) => `${esc(r.company)} (${esc(fx(r).deadline ?? "")})`).join(", ")}`);
    // companies hiring for this profile again and again
    const counts = new Map<string, number>();
    for (const r of mine.filter((r) => (r.posted_at ?? 0) > now() - 30 * 86400)) counts.set(r.company, (counts.get(r.company) ?? 0) + 1);
    const repeat = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (repeat.length) lines.push(`Hiring repeatedly: ${repeat.map(([c, n]) => `${esc(c)} (${n})`).join(", ")} - worth an unsolicited application`);
    // the one skill most asked for that isn't on the list
    const have = new Set(p[w].skills.map((s) => s.toLowerCase()));
    const asked = new Map<string, number>();
    for (const r of newThisWeek) for (const s of fx(r).skills ?? []) if (!have.has(s.toLowerCase())) asked.set(s, (asked.get(s) ?? 0) + 1);
    const top = [...asked].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 2) lines.push(`Worth learning: <b>${esc(top[0])}</b> - asked in ${top[1]} of ${newThisWeek.length} new matches, not on the skills list`);
    parts.push(`\n${p[w].icon} <b>${p[w].name}</b>\n${lines.join("\n")}`);
  }
  return parts.join("\n");
}

/** One line for /status. */
export async function jobsLine(store: Store, db: D1Database): Promise<string> {
  if ((await store.kvGet("jobs_on")) === "0") return "Jobs:            ⏸ paused";
  await ensureTable(db);
  const r = await db.prepare("SELECT MAX(first_seen) t, SUM(status='posted') open, SUM(status='approved') saved FROM jobs").first<{ t: number | null; open: number | null; saved: number | null }>();
  return `Jobs:            ✅ ${r?.open ?? 0} new, ${r?.saved ?? 0} on the waiting list` + (r?.t ? `, last new one ${fmtLeft(Math.max(0, now() - r.t))} ago` : "");
}
