// Jobs for two people - Diba (data science / analytics / data engineering)
// and Arman (frontend / React Native) - posted to the Jobs topic as cards
// that double as an application tracker.
//
// Sources, both public and meant to be read by programs:
//   - Bundesagentur für Arbeit, Jobbörse: keyword searches around Berlin and
//     Cottbus, two per tick in rotation
//   - Arbeitnow: a free feed of German (often English-speaking) tech jobs,
//     every two hours; Berlin, Cottbus or remote
//
// Rules drop the obvious misses for free (senior/lead roles, Ausbildung,
// titles that aren't data or frontend work). One cheap AI call per remaining
// job decides who it's for, why, what's missing, the German level, hours,
// start, deadline - and flags full-time roles a student permit can't cover.
// Cover letters are only written on request, with the better model.
//
// Personal data (profiles, CV text, skills) lives in D1 (kv jobs_people,
// jobs_skills:<who>), never in this public repo - see seed-jobs.sh.

import { aiFailed, aiWorked } from "./aikey.ts";
import { fmtLeft } from "./settings.ts";
import type { Store } from "./store.ts";
import { esc, inTopic, type Button, type Telegram } from "./telegram.ts";

export const JOBS_CRON = "3,13,23,33,43,53 * * * *";
const QUERIES_PER_TICK = 2;
const ASSESS_PER_TICK = 3;
const POST_PER_TICK = 4;
const MAX_ATTEMPTS = 3;
const FOLLOW_UP_DAYS = 10;
const ARBEITNOW_EVERY = 2 * 3600;
const LOCK_SECONDS = 300;

export type Who = "diba" | "arman";
const WHO: Who[] = ["diba", "arman"];
const NAME: Record<Who, string> = { diba: "Diba", arman: "Arman" };
const ICON: Record<Who, string> = { diba: "👩‍💻", arman: "🧑‍💻" };

export interface JobsEnv {
  DB: D1Database;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;      // cover letters
  FINDS_MODEL?: string;      // matching (the budget model)
  TOPIC_JOBS?: string;
}

const now = () => Math.floor(Date.now() / 1000);
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10).split("-").reverse().slice(0, 2).join(".");

// ---------------------------------------------------------------- searches
// [keywords, who it's mainly for] × [place, radius km]
const KEYWORDS: [string, Who][] = [
  ["Werkstudent Data", "diba"], ["Werkstudent Data Analyst", "diba"], ["Werkstudent Data Science", "diba"],
  ["Werkstudent Business Intelligence", "diba"], ["Data Analyst", "diba"], ["Data Scientist", "diba"],
  ["Data Engineer", "diba"], ["Business Analyst", "diba"],
  ["Werkstudent Frontend", "arman"], ["Werkstudent Softwareentwicklung", "arman"],
  ["Werkstudent Webentwicklung", "arman"], ["Frontend", "arman"], ["React", "arman"], ["React Native", "arman"],
];
const PLACES: [string, number][] = [["Berlin", 25], ["Cottbus", 50]];
export const BA_SEARCHES = KEYWORDS.flatMap(([q]) => PLACES.map(([wo, r]) => ({ q, wo, r })));

const BA = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service";
const BA_KEY = { "X-API-Key": "jobboerse-jobsuche" };   // the Jobbörse's public client key

// ---------------------------------------------------------------- rules
const SENIOR = /\b(senior|sr\.|lead|leitung|leiter|head of|principal|staff|director|chief|vp)\b|teamleit|abteilungsleit|bereichsleit/;
const NOT_A_JOB = /\b(ausbildung|azubi|auszubildende|duales studium|dual(er|es)? student|umschulung|minijob|freelance|freiberuf|selbstständig|ehrenamt)\b/;
// the title has to be about data work or frontend/software work at all
const ON_TOPIC = /data|daten|analyst|analytics|analytik|scien|statisti|machine learning|\bml\b|\bki\b|\bai\b|business intelligence|\bbi\b|reporting|python|sql|frontend|front-end|react|javascript|typescript|web ?entwick|web ?develop|software|developer|entwickler|engineer|programm|backend|fullstack|full-stack|mobile|\bapp\b|ios|android/;

/** Why a job is clearly not for either of us, by title, or null. */
export function jobRejectReason(title: string): string | null {
  const t = title.toLowerCase();
  if (SENIOR.test(t)) return "senior or lead role";
  if (NOT_A_JOB.test(t)) return "apprenticeship, freelance or similar";
  if (!ON_TOPIC.test(t)) return "not data or frontend work";
  return null;
}

/** Same job from another source: company + title, without legal forms and (m/w/d). */
export const dedupeKey = (company: string, title: string) =>
  (company.toLowerCase().replace(/\b(gmbh|ag|se|kg|co|mbh|ug|e\.v|inc|ltd)\b|[^\p{L}\d]+/gu, "") + "|" +
   title.toLowerCase().replace(/\((m|w|d|f|x|div)[^)]*\)/g, "").replace(/[^\p{L}\d]+/gu, "")).slice(0, 160);

const strip = (html: string) =>
  html.replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

// ---------------------------------------------------------------- storage
const COLUMNS: Record<string, string> = {
  id: "TEXT PRIMARY KEY",        // ba:<refnr> | an:<slug>
  dkey: "TEXT",                  // dedupeKey across sources
  source: "TEXT", title: "TEXT", company: "TEXT", place: "TEXT", url: "TEXT",
  remote: "INTEGER", kind: "TEXT", text: "TEXT",
  status: "TEXT NOT NULL",       // new → ready → posted → applied → interview → offer | rejected; skipped
  why: "TEXT", person: "TEXT",   // diba | arman | both; who applied, once applied
  facts: "TEXT",                 // JSON from the AI: why, gaps, german, hours, start, deadline, lang, skills
  attempts: "INTEGER NOT NULL DEFAULT 0",
  first_seen: "INTEGER NOT NULL", posted_at: "INTEGER", applied_at: "INTEGER",
  replied_at: "INTEGER", reminded: "INTEGER NOT NULL DEFAULT 0", msg_id: "INTEGER",
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
  replied_at: number | null; reminded: number; msg_id: number | null;
}
interface Facts {
  for: "diba" | "arman" | "both" | "none"; reason?: string; kind: string; why: string;
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

async function fetchArbeitnow(): Promise<Found[]> {
  const r = await fetch("https://www.arbeitnow.com/api/job-board-api");
  if (!r.ok) throw new Error(`Arbeitnow ${r.status}`);
  const d = (await r.json()) as any;
  return (d.data ?? [])
    .filter((j: any) => j.remote || /berlin|cottbus/i.test(j.location ?? ""))
    .map((j: any) => ({
      id: "an:" + j.slug, source: "Arbeitnow", title: j.title ?? "", company: j.company_name ?? "",
      place: [j.location, j.remote ? "remote" : ""].filter(Boolean).join(" · "), url: j.url,
      remote: !!j.remote, kind: (j.job_types ?? []).join(", "), text: strip(j.description ?? ""),
    }));
}

// ---------------------------------------------------------------- the AI
interface Person { name: string; summary: string; cv: string; skills: string[] }
async function people(store: Store): Promise<Record<Who, Person>> {
  const raw = await store.kvGet("jobs_people");
  if (!raw) throw new Error("No jobs_people in D1 - run cf/seed-jobs.sh");
  const p = JSON.parse(raw) as Record<Who, Person>;
  for (const w of WHO) {
    const s = await store.kvGet(`jobs_skills:${w}`);
    if (s) p[w].skills = JSON.parse(s);
  }
  return p;
}

const MATCH = `You match German job ads to two job seekers. Both are non-EU master's students in Cottbus on a student residence permit: they may work up to 20 hours a week during the semester (Werkstudent jobs and internships fit); a full-time job does not fit that permit.

DIBA wants: Data Scientist (not senior), Data Analyst, Data Engineer, BI/analytics roles - Werkstudent roles first, then internships and junior roles.
ARMAN wants: frontend / web / React / React Native / mobile developer roles - Werkstudent first, then junior or mid-level.

Return JSON only:
{"for": "diba"|"arman"|"both"|"none", "reason": string, "kind": "werkstudent"|"internship"|"thesis"|"junior"|"full-time"|"other", "why": string, "gaps": [string], "german": string, "hours": string, "start": string, "deadline": string, "lang": "de"|"en", "skills": [string]}

for: who should apply, from the profiles below. "none" only for senior roles, unrelated work, roles needing far more experience than they have, and roles requiring native German. A full-time junior or entry-level role is NOT "none": return it with kind "full-time" (it gets a warning, and companies sometimes offer such roles part-time). If "none", give reason (max 8 words) and leave the rest empty.
why: one line, under 110 characters, why it fits that person - name the concrete overlap.
gaps: 0-3 short things the ad asks for that the profile doesn't show, each with a hint how to cover it if there is one (e.g. "dbt - mention the SQL reporting pipelines from the last job").
german: the German level the ad needs, short ("C1 / fluent", "basic", "not needed"). hours: hours a week if stated, else "". start/deadline: as stated, else "". lang: the ad's language.
skills: up to 8 concrete skills/tools the ad asks for, short canonical names ("Power BI", "dbt", "TypeScript").
Never invent facts about the people.`;

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

async function match(env: JobsEnv, p: Record<Who, Person>, row: JobRow, text: string): Promise<Facts> {
  const user =
    `DIBA: ${p.diba.summary}\nSkills: ${p.diba.skills.join(", ")}\n\n` +
    `ARMAN: ${p.arman.summary}\nSkills: ${p.arman.skills.join(", ")}\n\n` +
    `=== JOB ===\nTitle: ${row.title}\nCompany: ${row.company}\nPlace: ${row.place}\nType: ${row.kind || "?"}\n\n` +
    text.slice(0, 1500);
  const d = JSON.parse(await ai(env.OPENAI_API_KEY, env.FINDS_MODEL || "gpt-5.6-luna", MATCH, user) || "{}");
  const arr = (x: unknown, n: number) => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, n) : []);
  return {
    for: ["diba", "arman", "both"].includes(d.for) ? d.for : "none",
    reason: String(d.reason ?? "").slice(0, 80), kind: String(d.kind ?? "other"),
    why: String(d.why ?? "").slice(0, 140), gaps: arr(d.gaps, 3).map((g) => g.slice(0, 110)),
    german: String(d.german ?? ""), hours: String(d.hours ?? ""), start: String(d.start ?? ""),
    deadline: String(d.deadline ?? ""), lang: d.lang === "en" ? "en" : "de", skills: arr(d.skills, 8),
  };
}

// ---------------------------------------------------------------- one tick
export async function jobsStep(env: JobsEnv, store: Store, tg: Telegram): Promise<string> {
  const db = env.DB;
  if ((await store.kvGet("jobs_on")) === "0") return "jobs: paused";
  if (!(await takeLock(db))) return "jobs: another run is still going";
  try {
    await ensureTable(db);
    const did: string[] = [];
    did.push(await collect(db, store));
    did.push(await assess(env, store, tg));
    const posted = await post(env, tg);
    if (posted) did.push(`${posted} posted`);
    const due = await remind(env, tg);
    if (due) did.push(`${due} reminders`);
    if (await weekly(env, store, tg)) did.push("weekly report");
    return `jobs: ${did.filter(Boolean).join(", ")}`;
  } finally {
    await store.kvSet("jobs_lock", "0");
  }
}

async function collect(db: D1Database, store: Store): Promise<string> {
  const found: Found[] = [];
  const out: string[] = [];
  const i = Number((await store.kvGet("jobs_query")) ?? 0);
  for (let k = 0; k < QUERIES_PER_TICK; k++) {
    const q = BA_SEARCHES[(i + k) % BA_SEARCHES.length];
    try { found.push(...(await fetchBA(q))); out.push(`"${q.q}" ${q.wo}`); }
    catch (e: any) { out.push(`${q.q}: ${e?.message ?? e}`); }
  }
  await store.kvSet("jobs_query", String((i + QUERIES_PER_TICK) % BA_SEARCHES.length));
  if (now() - Number((await store.kvGet("jobs_arbeitnow_at")) ?? 0) >= ARBEITNOW_EVERY) {
    try { found.push(...(await fetchArbeitnow())); out.push("Arbeitnow"); await store.kvSet("jobs_arbeitnow_at", String(now())); }
    catch (e: any) { out.push(`Arbeitnow: ${e?.message ?? e}`); }
  }
  if (!found.length) return out.join(" + ") + ": nothing";

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
  let fresh = 0, keep = 0;
  for (const f of found) {
    const dkey = dedupeKey(f.company, f.title);
    if (known.has(f.id) || known.has(dkey)) continue;
    known.add(f.id); known.add(dkey);
    fresh++;
    const why = jobRejectReason(f.title);
    if (!why) keep++;
    await db.prepare(
      `INSERT OR IGNORE INTO jobs (id,dkey,source,title,company,place,url,remote,kind,text,status,why,first_seen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(f.id, dkey, f.source, f.title, f.company, f.place, f.url, f.remote ? 1 : 0, f.kind,
            f.text ? f.text.slice(0, 6000) : null, why ? "skipped" : "new", why, now()).run();
  }
  return `${out.join(" + ")}: ${found.length} found, ${fresh} new, ${keep} to match`;
}

async function assess(env: JobsEnv, store: Store, tg: Telegram): Promise<string> {
  const db = env.DB;
  const { results } = await db.prepare(
    "SELECT * FROM jobs WHERE status='new' ORDER BY first_seen, rowid LIMIT ?").bind(ASSESS_PER_TICK).all<JobRow>();
  if (!results?.length) return "";
  const p = await people(store);
  let ok = 0, none = 0;
  for (const row of results) {
    try {
      const text = row.text ?? (row.id.startsWith("ba:") ? await detailsBA(row.id) : "");
      const f = await match(env, p, row, text);
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
  junior: "💼 Junior", "full-time": "⚠️ Full-time - more than a student permit allows", other: "💼 Job",
};
const STATUS: Record<string, string> = {
  posted: "", applied: "✅ Applied", already: "🔁 Applied before", interview: "🗓 Interview",
  rejected: "❌ Rejected", offer: "🎉 Offer", skipped: "⏭ Skipped",
};

const forWhom = (p: string | null) =>
  p === "both" ? "👥 For Diba & Arman" : p === "diba" || p === "arman" ? `${ICON[p]} For ${NAME[p]}` : "";

export function card(row: JobRow): string {
  const f: Partial<Facts> = row.facts ? JSON.parse(row.facts) : {};
  const facts = [
    f.german ? `🗣 German: ${f.german}` : "", f.hours ? `⏱ ${f.hours}` : "",
    f.start ? `📅 start ${f.start}` : "", f.deadline ? `⏳ apply by ${f.deadline}` : "",
  ].filter(Boolean).join(" · ");
  const st = STATUS[row.status] ?? "";
  const who = row.status !== "posted" && (row.person === "diba" || row.person === "arman") && row.applied_at
    ? ` by ${NAME[row.person as Who]}` : "";
  return (
    `💼 <b>${esc(row.title)}</b>\n` +
    `${esc(row.company)}${row.place ? ` · ${esc(row.place)}` : ""} · via ${row.source}\n` +
    `${forWhom(row.person)} · ${KIND[f.kind ?? "other"] ?? KIND.other}\n` +
    (f.why ? `<i>${esc(f.why)}</i>\n` : "") +
    (f.gaps?.length ? `Gaps: ${f.gaps.map(esc).join(" · ")}\n` : "") +
    (facts ? `${esc(facts)}\n` : "") +
    `<a href="${esc(row.url)}">open the job</a>` +
    (st ? `\n\n<b>${st}${who}${row.applied_at ? ` · ${day(row.applied_at)}` : ""}</b>` : "")
  );
}

/** The buttons for where the application is now. */
export function jobKeyboard(row: JobRow): Button[][] {
  const id = row.id;
  const both = row.person === "both";
  const two = (a: string, label: string) => both
    ? [{ text: `${label} (Diba)`, callback_data: `jb:${a}:diba:${id}` }, { text: `${label} (Arman)`, callback_data: `jb:${a}:arman:${id}` }]
    : [{ text: label, callback_data: `jb:${a}:${row.person}:${id}` }];
  switch (row.status) {
    case "posted":
      return [two("letter", "✍️ Cover letter"), two("applied", "✅ Applied"),
        [...two("already", "🔁 Already applied").slice(0, both ? 2 : 1), { text: "⏭ Skip", callback_data: `jb:skip:-:${id}` }]];
    case "applied": case "already":
      return [[{ text: "🗓 Interview", callback_data: `jb:interview:-:${id}` },
        { text: "❌ Rejected", callback_data: `jb:rejected:-:${id}` }, { text: "🎉 Offer", callback_data: `jb:offer:-:${id}` }]];
    case "interview":
      return [[{ text: "❌ Rejected", callback_data: `jb:rejected:-:${id}` }, { text: "🎉 Offer", callback_data: `jb:offer:-:${id}` }]];
    default:
      return [];
  }
}

const topic = (env: JobsEnv) => inTopic(Number(env.TOPIC_JOBS) || null);

async function post(env: JobsEnv, tg: Telegram): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare(
    "SELECT * FROM jobs WHERE status='ready' ORDER BY first_seen, rowid LIMIT ?").bind(POST_PER_TICK).all<JobRow>();
  let n = 0;
  for (const row of results ?? []) {
    const shown = { ...row, status: "posted" };
    try {
      const r = await tg.send(card(shown), { ...tg.keyboard(jobKeyboard(shown)), ...topic(env) });
      await setJob(db, row.id, { status: "posted", posted_at: now(), msg_id: r?.result?.message_id ?? null });
      n++;
    } catch (e: any) {
      if (String(e?.message).includes(" 429")) break;
      const tries = row.attempts + 1;
      await setJob(db, row.id, tries >= MAX_ATTEMPTS ? { attempts: tries, status: "skipped", why: "could not post" } : { attempts: tries });
    }
  }
  return n;
}

async function remind(env: JobsEnv, tg: Telegram): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM jobs WHERE status IN ('applied','already') AND reminded=0 AND applied_at < ? LIMIT 3`)
    .bind(now() - FOLLOW_UP_DAYS * 86400).all<JobRow>();
  for (const row of results ?? []) {
    const who = row.person === "diba" || row.person === "arman" ? `${NAME[row.person as Who]}, ` : "";
    await tg.send(
      `⏰ ${who}no answer from <b>${esc(row.company)}</b> for <i>${esc(row.title)}</i> after ${FOLLOW_UP_DAYS} days. ` +
      `A short follow-up email often helps - or mark it below.`,
      { ...tg.keyboard(jobKeyboard(row)), ...topic(env), ...(row.msg_id ? { reply_to_message_id: row.msg_id } : {}) });
    await setJob(db, row.id, { reminded: 1 });
  }
  return results?.length ?? 0;
}

// ---------------------------------------------------------------- buttons
/** jb:<action>:<who|->:<id> - pressed by anyone in the group. */
export async function jobButton(env: JobsEnv, store: Store, tg: Telegram, cq: any): Promise<void> {
  const db = env.DB;
  await ensureTable(db);
  const [, act, who, ...rest] = String(cq.data).split(":");
  const id = rest.join(":");
  const row = await db.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first<JobRow>();
  if (!row) { await tg.answerCallback(cq.id, "Unknown job"); return; }

  if (act === "letter") {
    await tg.answerCallback(cq.id, "Writing the cover letter…");
    const w = (who as Who) in NAME ? (who as Who) : "diba";
    try {
      const letter = await coverLetter(env, store, row, w);
      await tg.send(`✍️ <b>Cover letter for ${NAME[w]}</b> - ${esc(row.company)}\n\n<pre>${esc(letter)}</pre>`,
        { ...topic(env), ...(cq.message?.message_id ? { reply_to_message_id: cq.message.message_id } : {}) });
    } catch (e: any) {
      await aiFailed(store, tg, e);
      await tg.send("Couldn't write it right now - try the button again in a bit.", topic(env));
    }
    return;
  }

  const t = now();
  const next: Record<string, Record<string, unknown>> = {
    applied: { status: "applied", applied_at: t, person: who },
    already: { status: "already", applied_at: t, person: who },
    skip: { status: "skipped", why: "skipped by you" },
    interview: { status: "interview", replied_at: row.replied_at ?? t },
    rejected: { status: "rejected", replied_at: row.replied_at ?? t },
    offer: { status: "offer", replied_at: row.replied_at ?? t },
  };
  if (!next[act]) { await tg.answerCallback(cq.id); return; }
  await setJob(db, id, next[act]);
  const updated = { ...row, ...next[act] } as JobRow;
  await tg.answerCallback(cq.id, STATUS[updated.status] || "Saved");
  const msgId = row.msg_id ?? cq.message?.message_id;
  try { await tg.editText(cq.message.chat.id, msgId, card(updated), jobKeyboard(updated)); } catch { /* unchanged or too old */ }
  // the reminder message itself loses its buttons once answered
  if (cq.message?.message_id && cq.message.message_id !== msgId)
    try { await tg.clearKeyboard(cq.message.chat.id, cq.message.message_id); } catch { /* fine */ }
}

async function coverLetter(env: JobsEnv, store: Store, row: JobRow, w: Who): Promise<string> {
  const p = await people(store);
  const f: Partial<Facts> = row.facts ? JSON.parse(row.facts) : {};
  const lang = f.lang === "en" ? "English" : "German";
  const sys = `You write short, specific job applications (cover letters) for ${NAME[w]}. Write in ${lang}, ${lang === "German" ? "as an Anschreiben with \"Sie\"" : "in a friendly professional tone"}. 180-250 words, body only (no address block, no date), ending with a greeting and the name ${p[w].name}.
Open with why this role and company, then 2-3 concrete matches between the ad and the CV (name projects, tools, numbers from the CV), then availability (master's student in Cottbus; as a Werkstudent up to 20 hours a week during the semester) and a short close. Use only facts from the CV - never invent experience, tools or numbers. No clichés like "I am writing to apply" or "hiermit bewerbe ich mich".`;
  const user = `=== CV ===\n${p[w].cv}\n\n=== JOB ===\nTitle: ${row.title}\nCompany: ${row.company}\nPlace: ${row.place}\n\n${(row.text ?? "").slice(0, 3000)}`;
  const out = await ai(env.OPENAI_API_KEY, env.OPENAI_MODEL, sys, user, false);
  await aiWorked(store);
  return out.trim();
}

// ---------------------------------------------------------------- /jobs, /skills
const DONE = ["applied", "already", "interview", "rejected", "offer"];

export async function jobsBoard(db: D1Database): Promise<string> {
  await ensureTable(db);
  const { results } = await db.prepare(
    `SELECT person, status, COUNT(*) n FROM jobs WHERE status IN ('posted','applied','already','interview','rejected','offer')
     GROUP BY person, status`).all<{ person: string; status: string; n: number }>();
  const by: Record<string, Record<string, number>> = {};
  for (const r of results ?? []) {
    const ps = r.person === "both" ? WHO : [r.person];
    for (const p of ps) (by[p] ??= {})[r.status] = (by[p][r.status] ?? 0) + r.n;
  }
  const line = (w: Who) => {
    const s = by[w] ?? {};
    const applied = DONE.reduce((a, k) => a + (s[k] ?? 0), 0);
    const answered = (s.interview ?? 0) + (s.rejected ?? 0) + (s.offer ?? 0);
    return `${ICON[w]} <b>${NAME[w]}</b>: ${s.posted ?? 0} open · ${applied} applied · ` +
      `${applied - answered} waiting · ${s.interview ?? 0} interviews · ${s.rejected ?? 0} rejected · ${s.offer ?? 0} offers`;
  };
  return `💼 <b>Jobs</b> (Berlin, Cottbus, remote)\n\n${line("diba")}\n${line("arman")}\n\n` +
    `<i>/skills diba - see or change the skills list the bot matches against</i>`;
}

/** /skills diba · /skills diba + Power BI · /skills arman - Vue */
export async function skillsCommand(store: Store, args: string[]): Promise<string> {
  const w = (args[0] ?? "").toLowerCase() as Who;
  if (!WHO.includes(w)) return "Try /skills diba, /skills diba + Power BI, /skills arman - Vue";
  const p = await people(store);
  let list = p[w].skills;
  const op = args[1], skill = args.slice(2).join(" ").trim();
  if ((op === "+" || op === "-") && skill) {
    list = op === "+" ? [...list.filter((s) => s.toLowerCase() !== skill.toLowerCase()), skill]
      : list.filter((s) => s.toLowerCase() !== skill.toLowerCase());
    await store.kvSet(`jobs_skills:${w}`, JSON.stringify(list));
  }
  return `${ICON[w]} <b>${NAME[w]}'s skills</b> (what jobs are matched against):\n${esc(list.join(", "))}`;
}

// ---------------------------------------------------------------- weekly report
async function weekly(env: JobsEnv, store: Store, tg: Telegram): Promise<boolean> {
  const d = new Date();
  if (d.getUTCDay() !== 1 || d.getUTCHours() < 7) return false;          // Mondays from 07:00 UTC
  const week = d.toISOString().slice(0, 10);
  if ((await store.kvGet("jobs_weekly")) === week) return false;
  await store.kvSet("jobs_weekly", week);
  const text = await weeklyReport(env.DB, store);
  if (text) await tg.send(text, topic(env));
  return true;
}

export async function weeklyReport(db: D1Database, store: Store): Promise<string> {
  await ensureTable(db);
  const p = await people(store);
  const weekAgo = now() - 7 * 86400;
  const { results } = await db.prepare(
    `SELECT * FROM jobs WHERE person IS NOT NULL AND status NOT IN ('new','ready','skipped')`).all<JobRow>();
  const rows = results ?? [];
  const parts: string[] = ["📊 <b>Jobs - weekly report</b>"];
  for (const w of WHO) {
    const mine = rows.filter((r) => r.person === w || r.person === "both");
    const fx = (r: JobRow): Partial<Facts> => (r.facts ? JSON.parse(r.facts) : {});
    const newThisWeek = mine.filter((r) => (r.posted_at ?? 0) > weekAgo);
    const applied = mine.filter((r) => DONE.includes(r.status) && r.person === w);
    const answered = (rs: JobRow[]) => rs.filter((r) => ["interview", "rejected", "offer"].includes(r.status)).length;
    const positive = (rs: JobRow[]) => rs.filter((r) => ["interview", "offer"].includes(r.status)).length;
    const lines: string[] = [];
    const city = (c: string) => newThisWeek.filter((r) => (c === "remote" ? r.remote : r.place.toLowerCase().includes(c))).length;
    lines.push(`New matches this week: ${newThisWeek.length} (Berlin ${city("berlin")}, Cottbus ${city("cottbus")}, remote ${city("remote")})`);
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
    parts.push(`\n${ICON[w]} <b>${NAME[w]}</b>\n${lines.join("\n")}`);
  }
  return parts.join("\n");
}

/** One line for /status. */
export async function jobsLine(store: Store, db: D1Database): Promise<string> {
  if ((await store.kvGet("jobs_on")) === "0") return "Jobs:            ⏸ paused";
  await ensureTable(db);
  const r = await db.prepare("SELECT MAX(first_seen) t, SUM(status='posted') open FROM jobs").first<{ t: number | null; open: number | null }>();
  return `Jobs:            ✅ ${r?.open ?? 0} open` + (r?.t ? `, last new one ${fmtLeft(Math.max(0, now() - r.t))} ago` : "");
}
