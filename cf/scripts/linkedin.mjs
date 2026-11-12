// npm run linkedin - one search, now
//
// LinkedIn jobs, fetched from this computer: LinkedIn refuses requests from
// Cloudflare, but answers a home connection. Run when you want it (nothing is
// scheduled, nothing keeps running): this searches LinkedIn's public guest
// pages - no login, no cookies, no account involved - and after each search
// hands the new jobs to the Worker (POST /ingest/jobs), which matches and
// posts them like the rest.
//
// Gentle on purpose: at most 10 LinkedIn searches a run, 60-90 s apart, and
// no job pages (the bot matches on title, company and place). If
// LinkedIn says no (429, 999, a login wall), the run stops at once.
//
// neustart.yaml, optional:
//   jobs:
//     linkedin:
//       searches: ["Werkstudent Data", "Data Analyst"]   # default: the people's own searches
// .env: NEUSTART_URL (the Worker's address) and INGEST_SECRET (also a Worker secret).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CF, check, readConfigFile, readEnv } from "./lib.mjs";

const { jobRejectReason } = await import(resolve(CF, "src/jobs.ts"));
const { unescapeHtml } = await import(resolve(CF, "src/scraper.ts"));

const MAX_REQUESTS = 10;
const GAP_MS = [60_000, 90_000];
const TERMS_PER_QUERY = 4;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const STATE = join(homedir(), ".neustart", "linkedin.json");
const LOG = join(homedir(), "Library", "Logs", "neustart-linkedin.log");

// ---------------------------------------------------------------- LinkedIn's pages
const text = (html) => unescapeHtml(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Search results: [{id, title, company, place}] */
export function parseSearch(html) {
  return html.split('data-entity-urn="urn:li:jobPosting:').slice(1).map((blk) => ({
    id: /^(\d+)/.exec(blk)?.[1] ?? "",
    title: text(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/.exec(blk)?.[1] ?? ""),
    company: text(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/.exec(blk)?.[1] ?? ""),
    place: text(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/.exec(blk)?.[1] ?? ""),
  })).filter((j) => j.id && j.title);
}

/** A job page: the description as plain text, and the employment type ("Teilzeit", "Full-time"). */
export function parseJob(html) {
  const body = /show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  const lines = unescapeHtml(body.replace(/<li[^>]*>/gi, "\n• ").replace(/<\/(li|p|ul|ol|h\d|strong)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const item = [...html.matchAll(/job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/g)]
    .find((m) => /beschäftigungsverhältnis|employment type/i.test(text(m[1])));
  return { text: lines.join("\n").slice(0, 6000), kind: item ? text(item[2]) : "" };
}

/** The searches: each active person's, a few terms per query, in each of the config's cities. */
export function queriesFor(cfg, active, opts = {}) {
  const terms = opts.searches?.length ? opts.searches
    : cfg.jobs.people.filter((p) => active.includes(p.id)).flatMap((p) => p.searches);
  const groups = [];
  for (let i = 0; i < terms.length; i += TERMS_PER_QUERY)
    groups.push(terms.slice(i, i + TERMS_PER_QUERY).map((t) => `"${t}"`).join(" OR "));
  return groups.flatMap((keywords) => cfg.jobs.cities.map((c) => ({ keywords, location: c.name })));
}

// posted since: the seconds back to the last run, at least a day, at most a week
const searchUrl = (q, since = 86400) => "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?" +
  new URLSearchParams({ keywords: q.keywords, location: q.location, f_TPR: `r${since}` });
export const lookBack = (lastRun, t) => Math.min(7 * 86400, Math.max(86400, Math.ceil((t - (lastRun ?? 0)) / 1000) + 3600));
const jobUrl = (id) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;

// ---------------------------------------------------------------- one run
class Limited extends Error {}
const readState = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } };
const saveState = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(s, null, 1)); };

export async function run(cfg, { fetch, sleep, now, state = STATE, env, log = () => {}, progress = () => {}, opts = {} }) {
  const st = readState(state);
  const done = (status, extra = {}) => { saveState(state, { lastRun: now(), lastResult: status, ...extra }); return { status, ...extra }; };
  if (!cfg.modules.jobs) return { status: "off" };
  if (!env.INGEST_SECRET || !env.NEUSTART_URL) return { status: "no secret" };
  const active = cfg.jobs.people.filter((p) => p.active).map((p) => p.id);
  if (!active.length) active.push(cfg.jobs.people[0].id);
  const bot = async (body) => {
    const r = await fetch(`${env.NEUSTART_URL.replace(/\/$/, "")}/ingest/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Ingest-Secret": env.INGEST_SECRET }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`the bot answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  const queries = queriesFor(cfg, active, opts).slice(0, MAX_REQUESTS);
  const since = lookBack(st.lastRun, now());
  const p = { done: 0, total: queries.length, found: 0, handed: 0 };
  progress(p);
  const seen = new Set();
  try {
    for (const q of queries) {
      if (p.done) { const ms = GAP_MS[0] + Math.random() * (GAP_MS[1] - GAP_MS[0]); await sleep(ms, p); }
      log(`search ${p.done + 1}/${p.total}: ${q.keywords.slice(0, 70)} in ${q.location}`);
      const r = await fetch(searchUrl(q, since), { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" }, redirect: "manual" });
      p.done++;
      if (r.status !== 200) throw new Limited(`LinkedIn answered ${r.status}`);
      const html = await r.text();
      if (/authwall|uas\/login/.test(html.slice(0, 3000))) throw new Limited("LinkedIn wants a login");
      // handed to the bot at once: a refusal later loses nothing
      const jobs = parseSearch(html).filter((c) => !seen.has(c.id)).map((c) => {
        seen.add(c.id);
        return { id: `li:${c.id}`, source: "LinkedIn", title: c.title, company: c.company, place: c.place,
          url: `https://www.linkedin.com/jobs/view/${c.id}`, remote: /remote/i.test(c.place), kind: "" };
      });
      p.found += jobs.length;
      if (jobs.length) {
        const unknown = new Set((await bot({ op: "known", jobs })).unknown);
        const fresh = jobs.filter((j) => unknown.has(j.id));
        if (fresh.length) await bot({ op: "add", jobs: fresh });
        p.handed += fresh.length;
        log(`  ${jobs.length} found, ${fresh.length} new → handed to the bot`);
      } else log("  nothing found");
      progress(p);
    }
    return done("done", { found: p.found, new: p.handed });
  } catch (e) {
    if (!(e instanceof Limited)) throw e;
    progress(p);
    log(`${e.message} - stopping here; the ${p.handed} new job(s) found so far are with the bot`);
    return done("limited", { found: p.found, new: p.handed });
  }
}

// ---------------------------------------------------------------- the command
async function main() {
  const raw = existsSync(resolve(CF, "..", "neustart.yaml")) ? readConfigFile() : {};
  mkdirSync(dirname(LOG), { recursive: true });
  // keep the log small: its last 300 lines
  if (existsSync(LOG)) { const l = readFileSync(LOG, "utf8").split("\n"); if (l.length > 400) writeFileSync(LOG, l.slice(-300).join("\n")); }
  const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(LOG, line + "\n"); };
  console.log("Searching LinkedIn once: up to 10 searches, 60-90 s apart (about 10-15 minutes).");
  // the progress bar, on its own line, redrawn in place (only in a terminal)
  const tty = process.stdout.isTTY;
  let last = { done: 0, total: 0, found: 0, handed: 0 }, wait = "";
  const bar = () => {
    if (!tty || !last.total) return;
    const w = 20, f = Math.round((last.done / last.total) * w);
    process.stdout.write(`\r\x1b[2K[${"█".repeat(f)}${"░".repeat(w - f)}] ${last.done}/${last.total} searches · ${last.found} found · ${last.handed} to the bot${wait}`);
  };
  const say = (m) => { if (tty) process.stdout.write("\r\x1b[2K"); log(m); bar(); };
  const sleep = async (ms) => {
    for (let left = Math.ceil(ms / 1000); left > 0; left--) { wait = ` · next in ${left}s`; bar(); await new Promise((ok) => setTimeout(ok, 1000)); }
    wait = "";
  };
  let r;
  try {
    r = await run(await check(raw), {
      fetch, sleep, now: Date.now, env: readEnv(), log: say, progress: (p) => { last = { ...p }; bar(); }, opts: raw.jobs?.linkedin ?? {},
    });
    if (tty) process.stdout.write("\n");
  } catch (e) {
    if (tty) process.stdout.write("\n");
    log(`failed: ${e?.cause?.message ?? e?.message ?? e}`);
    process.exitCode = 1;
    return;
  }
  if (r.status !== "done") log(`run: ${r.status}`);
  else if (!r.found) log("nothing found");
  else log(`done - ${r.new} new job(s) went to the bot; the ones that fit show up in the jobs topic within the next half hour`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
