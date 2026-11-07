// npm run linkedin -- on | off | status | run
//
// LinkedIn jobs, fetched from this computer: LinkedIn refuses requests from
// Cloudflare, but answers a home connection. Twice a day (macOS's launchd,
// no process left running in between) this searches LinkedIn's public guest
// pages - no login, no cookies, no account involved - asks the bot which jobs
// are new, opens only the new ones that pass the bot's rules, and hands them
// to the Worker (POST /ingest/jobs), which matches and posts them like the
// rest.
//
// Gentle on purpose: at most 10 LinkedIn requests a run, 20-40 s apart. If
// LinkedIn says no (429, 999, a login wall), the run stops at once and the
// next day is skipped.
//
// neustart.yaml, optional:
//   jobs:
//     linkedin:
//       times: ["09:00", "18:00"]
//       searches: ["Werkstudent Data", "Data Analyst"]   # default: the people's own searches
// .env: NEUSTART_URL (the Worker's address) and INGEST_SECRET (also a Worker secret).
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CF, check, readConfigFile, readEnv } from "./lib.mjs";

const { jobRejectReason } = await import(resolve(CF, "src/jobs.ts"));
const { unescapeHtml } = await import(resolve(CF, "src/scraper.ts"));

const LABEL = "de.neustart.linkedin";
const MAX_REQUESTS = 10;
const GAP_MS = [20_000, 40_000];
const PAUSE_MS = 24 * 3600_000;
const TERMS_PER_QUERY = 4;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const STATE = join(homedir(), ".neustart", "linkedin.json");
const LOG = join(homedir(), "Library", "Logs", "neustart-linkedin.log");
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

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

const searchUrl = (q) => "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?" +
  new URLSearchParams({ keywords: q.keywords, location: q.location, f_TPR: "r86400" });
const jobUrl = (id) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;

// ---------------------------------------------------------------- one run
class Limited extends Error {}
const readState = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } };
const saveState = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(s, null, 1)); };

export async function run(cfg, { fetch, sleep, now, state = STATE, env, log = () => {}, opts = {} }) {
  const st = readState(state);
  const done = (status, extra = {}) => { saveState(state, { ...st, lastRun: now(), lastResult: status, ...extra }); return { status, ...extra }; };
  if ((st.pausedUntil ?? 0) > now()) return { status: "paused" };
  if (!cfg.modules.jobs) return { status: "off" };
  if (!env.INGEST_SECRET || !env.NEUSTART_URL) return { status: "no secret" };
  const active = cfg.jobs.people.filter((p) => p.active).map((p) => p.id);
  if (!active.length) active.push(cfg.jobs.people[0].id);

  let budget = MAX_REQUESTS, first = true;
  const linkedin = async (url) => {
    if (budget <= 0) return null;
    if (!first) await sleep(GAP_MS[0] + Math.random() * (GAP_MS[1] - GAP_MS[0]));
    first = false; budget--;
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" }, redirect: "manual" });
    if (r.status !== 200) throw new Limited(`LinkedIn answered ${r.status}`);
    const html = await r.text();
    if (/authwall|uas\/login/.test(html.slice(0, 3000))) throw new Limited("LinkedIn wants a login");
    return html;
  };
  const bot = async (body) => {
    const r = await fetch(`${env.NEUSTART_URL.replace(/\/$/, "")}/ingest/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Ingest-Secret": env.INGEST_SECRET }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`the bot answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  try {
    const cards = new Map();
    for (const q of queriesFor(cfg, active, opts)) {
      const html = await linkedin(searchUrl(q));
      if (html === null) break;
      for (const c of parseSearch(html)) cards.set(c.id, c);
    }
    const jobs = [...cards.values()].map((c) => ({
      id: `li:${c.id}`, source: "LinkedIn", title: c.title, company: c.company, place: c.place,
      url: `https://www.linkedin.com/jobs/view/${c.id}`, remote: /remote/i.test(c.place), kind: "",
    }));
    if (!jobs.length) return done("done", { found: 0 });
    const unknown = new Set((await bot({ op: "known", jobs })).unknown);
    const fresh = jobs.filter((j) => unknown.has(j.id));
    // the rule-rejected are handed in as they are (so they're known next time);
    // only the rest get their page opened, while the budget lasts
    const rejected = fresh.filter((j) => jobRejectReason(j.title, cfg.jobs, active, ""));
    const detailed = [];
    for (const j of fresh.filter((x) => !rejected.includes(x))) {
      const html = await linkedin(jobUrl(j.id.slice(3)));
      if (html === null) break;
      detailed.push({ ...j, ...parseJob(html) });
    }
    const add = [...rejected, ...detailed];
    const r = add.length ? await bot({ op: "add", jobs: add }) : { fresh: 0, keep: 0 };
    log(`found ${jobs.length}, new ${fresh.length}, opened ${detailed.length}, handed in ${add.length} (to match: ${r.keep})`);
    return done("done", { found: jobs.length, new: fresh.length, to_match: r.keep });
  } catch (e) {
    if (!(e instanceof Limited)) throw e;
    log(`${e.message} - stopping, and skipping the next day`);
    return done("limited", { pausedUntil: now() + PAUSE_MS });
  }
}

// ---------------------------------------------------------------- the schedule
/** A launchd job that runs this at the given times, at low priority, and nothing else. */
export function plist(node, script, cwd, log, times) {
  const at = times.map((t) => {
    const [h, m] = t.split(":").map(Number);
    return `      <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m || 0}</integer></dict>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>--no-warnings</string>
    <string>${script}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${cwd}</string>
  <key>StartCalendarInterval</key>
  <array>
${at}
  </array>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------- the command
async function main(cmd) {
  const uid = process.getuid();
  const launchctl = (...a) => spawnSync("launchctl", a, { encoding: "utf8" });
  const raw = existsSync(resolve(CF, "..", "neustart.yaml")) ? readConfigFile() : {};
  const opts = raw.jobs?.linkedin ?? {};
  const times = opts.times ?? ["09:00", "18:00"];
  if (cmd === "on") {
    mkdirSync(dirname(PLIST), { recursive: true }); mkdirSync(dirname(LOG), { recursive: true });
    writeFileSync(PLIST, plist(process.execPath, resolve(CF, "scripts/linkedin.mjs"), CF, LOG, times));
    launchctl("bootout", `gui/${uid}/${LABEL}`);
    const r = launchctl("bootstrap", `gui/${uid}`, PLIST);
    if (r.status !== 0) { console.error(`launchctl: ${r.stderr.trim()}`); process.exit(1); }
    console.log(`On: LinkedIn is searched at ${times.join(" and ")} (a missed time runs when the Mac wakes). Log: ${LOG}`);
  } else if (cmd === "off") {
    launchctl("bootout", `gui/${uid}/${LABEL}`);
    if (existsSync(PLIST)) unlinkSync(PLIST);
    console.log("Off: LinkedIn isn't searched any more. npm run linkedin -- on to start again.");
  } else if (cmd === "status") {
    const on = launchctl("print", `gui/${uid}/${LABEL}`).status === 0;
    const st = readState(STATE);
    const when = (t) => (t ? new Date(t).toLocaleString("de-DE") : "never");
    console.log(`${on ? `On, at ${times.join(" and ")}` : "Off"}. Last run: ${when(st.lastRun)} (${st.lastResult ?? "-"})` +
      ((st.pausedUntil ?? 0) > Date.now() ? `. LinkedIn said no - paused until ${when(st.pausedUntil)}` : ""));
    if (existsSync(LOG)) console.log(readFileSync(LOG, "utf8").trim().split("\n").slice(-5).join("\n"));
  } else if (cmd === "run") {
    mkdirSync(dirname(LOG), { recursive: true });
    // keep the log small: its last 300 lines
    if (existsSync(LOG)) { const l = readFileSync(LOG, "utf8").split("\n"); if (l.length > 400) writeFileSync(LOG, l.slice(-300).join("\n")); }
    const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(LOG, line + "\n"); };
    const r = await run(await check(raw), {
      fetch, sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)), now: Date.now, env: readEnv(), log, opts,
    });
    if (r.status !== "done") log(`run: ${r.status}`);
  } else {
    console.log("npm run linkedin -- on | off | status | run");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2]);
