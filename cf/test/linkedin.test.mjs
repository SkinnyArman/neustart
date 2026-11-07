// Offline tests for scripts/linkedin.mjs: reading LinkedIn's guest pages,
// the gentle request budget, stopping when LinkedIn says no, handing the
// jobs to the Worker, and the macOS schedule. No network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "./fixtures/config.mjs";

const L = await import(new URL("../scripts/linkedin.mjs", import.meta.url).href);
const { normalize } = await import(new URL("../src/config.ts", import.meta.url).pathname);
let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ✓", name); };

// ---------------------------------------------------------------- LinkedIn's markup
const card = (id, title, company, place) => `<li><div class="base-card relative w-full" data-entity-urn="urn:li:jobPosting:${id}">
  <a class="base-card__full-link" href="https://de.linkedin.com/jobs/view/x-${id}?trk=public_jobs"></a>
  <div class="base-search-card__info"><h3 class="base-search-card__title">
            ${title}
          </h3><h4 class="base-search-card__subtitle">
            <a class="hidden-nested-link" href="https://de.linkedin.com/company/c">
            ${company}
            </a></h4>
  <div class="base-search-card__metadata"><span class="job-search-card__location">
            ${place}
          </span></div></div></div></li>`;
const SEARCH = [card(101, "Werkstudent Data Analyst (m/w/d)", "Thales", "Berlin, Berlin, Deutschland"),
  card(102, "Senior Data Scientist", "Big &amp; Co", "Berlin, Berlin, Deutschland"),
  card(103, "Working Student Analytics", "Acme", "Cottbus, Brandenburg, Deutschland"),
  card(104, "Werkstudent Marketing", "Shop", "Berlin")].join("\n");
const JOB = `<div class="description__text"><section class="show-more-less-html"><div class="show-more-less-html__markup">
  <strong>Deine Aufgaben</strong><ul><li>SQL &amp; Python</li><li>Dashboards</li></ul><p>20 Stunden/Woche</p>
  </div></section></div><ul class="description__job-criteria-list">
  <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Beschäftigungsverhältnis</h3>
  <span class="description__job-criteria-text description__job-criteria-text--criteria">
          Teilzeit
        </span></li></ul>`;

console.log("\n1. reading LinkedIn's pages");
await ok("search results: id, title, company, place", () => {
  const r = L.parseSearch(SEARCH);
  assert.equal(r.length, 4);
  assert.deepEqual(r[0], { id: "101", title: "Werkstudent Data Analyst (m/w/d)", company: "Thales", place: "Berlin, Berlin, Deutschland" });
  assert.equal(r[1].company, "Big & Co");
});
await ok("a job page: the description as text, and the employment type", () => {
  const j = L.parseJob(JOB);
  assert.match(j.text, /Deine Aufgaben\n• SQL & Python\n• Dashboards\n20 Stunden\/Woche/);
  assert.equal(j.kind, "Teilzeit");
});
await ok("searches: each active person's, a few terms per query, in each city", () => {
  const cfg = normalize(CONFIG);
  const q = L.queriesFor(cfg, ["diba"]);
  assert.equal(q.length, 4);                         // 8 searches in 2 queries x Berlin, Cottbus
  assert.equal(q[0].location, "Berlin");
  assert.equal(q[0].keywords, '"Werkstudent Data" OR "Werkstudent Data Analyst" OR "Werkstudent Data Science" OR "Werkstudent Business Intelligence"');
  assert.deepEqual(L.queriesFor(cfg, ["diba"], { searches: ["Data Analyst"] }).map((x) => x.keywords), ['"Data Analyst"', '"Data Analyst"']);
});

// ---------------------------------------------------------------- a run
console.log("\n2. a run");
const dir = mkdtempSync(join(tmpdir(), "neustart-li-"));
function harness({ limitAt = Infinity, unknown } = {}) {
  const calls = [], posted = [], waits = [];
  let n = 0;
  const fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes("/ingest/jobs")) {
      const body = JSON.parse(init.body);
      assert.equal(init.headers["X-Ingest-Secret"], "sec");
      posted.push(body);
      if (body.op === "known") return Response.json({ unknown: unknown ?? body.jobs.map((j) => j.id) });
      return Response.json({ fresh: body.jobs.length, keep: 1 });
    }
    calls.push(url);
    if (++n >= limitAt) return new Response("", { status: 429 });
    return new Response(url.includes("/jobPosting/") ? JOB : SEARCH);
  };
  return { calls, posted, waits, deps: { fetch, sleep: async (ms) => { waits.push(ms); }, now: () => Date.UTC(2026, 10, 8, 9, 0),
    state: join(dir, `state-${Math.random()}.json`), env: { NEUSTART_URL: "https://bot.example", INGEST_SECRET: "sec" }, log: () => {} } };
}
const cfg = normalize(CONFIG);
{
  const h = harness();
  const r = await L.run(cfg, h.deps);
  await ok("searches, then asks the bot what's new, opens only new jobs that pass the rules, hands them in", () => {
    const searches = h.calls.filter((u) => u.includes("seeMoreJobPostings"));
    const pages = h.calls.filter((u) => u.includes("/jobPosting/"));
    assert.equal(searches.length, 4);
    assert.ok(searches.every((u) => /f_TPR=r86400/.test(u) && !/cookie/i.test(u)));
    assert.deepEqual(pages.map((u) => u.split("/").pop()).sort(), ["101", "103"]);   // not the senior one, not marketing
    const add = h.posted.find((p) => p.op === "add");
    assert.ok(add.jobs.every((j) => j.source === "LinkedIn" && /^li:\d+$/.test(j.id)));
    const j101 = add.jobs.find((j) => j.id === "li:101");
    assert.equal(j101.url, "https://www.linkedin.com/jobs/view/101"); assert.equal(j101.kind, "Teilzeit"); assert.match(j101.text, /SQL & Python/);
    assert.ok(add.jobs.find((j) => j.id === "li:102"), "rule-rejected ones are handed in too, so they're known next time");
    assert.equal(r.status, "done");
  });
  await ok("gentle: 20-40 s between LinkedIn requests, at most 10 a run", () => {
    assert.ok(h.waits.length >= h.calls.length - 1);
    assert.ok(h.waits.every((ms) => ms >= 20000 && ms <= 40000));
    assert.ok(h.calls.length <= 10);
  });
}
{
  const h = harness({ unknown: [] });
  await L.run(cfg, h.deps);
  await ok("nothing new: no job page is opened", () => assert.equal(h.calls.filter((u) => u.includes("/jobPosting/")).length, 0));
}
{
  const h = harness({ limitAt: 2 });
  const r = await L.run(cfg, h.deps);
  await ok("LinkedIn says 'too many requests': stops at once and sits out a day", () => {
    assert.equal(h.calls.length, 2);
    assert.equal(r.status, "limited");
    const st = JSON.parse(readFileSync(h.deps.state, "utf8"));
    assert.equal(st.pausedUntil, Date.UTC(2026, 10, 9, 9, 0));
  });
  const again = await L.run(cfg, h.deps);
  await ok("…the next run inside that day doesn't touch LinkedIn", () => {
    assert.equal(again.status, "paused"); assert.equal(h.calls.length, 2);
  });
}
await ok("jobs switched off in the config, or no secret: nothing is fetched", async () => {
  const h = harness();
  assert.equal((await L.run(normalize({ ...CONFIG, modules: { ...CONFIG.modules, jobs: false } }), h.deps)).status, "off");
  assert.equal((await L.run(cfg, { ...h.deps, env: {} })).status, "no secret");
  assert.equal(h.calls.length, 0);
});

// ---------------------------------------------------------------- the schedule
console.log("\n3. the schedule");
await ok("a launchd job at 9:00 and 18:00, low priority, logging to a file", () => {
  const p = L.plist("/usr/local/bin/node", "/x/cf/scripts/linkedin.mjs", "/x/cf", "/tmp/li.log", ["09:00", "18:00"]);
  assert.match(p, /<string>de\.neustart\.linkedin<\/string>/);
  assert.match(p, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>--no-warnings<\/string>\s*<string>\/x\/cf\/scripts\/linkedin\.mjs<\/string>\s*<string>run<\/string>/);
  assert.match(p, /<key>Hour<\/key><integer>9<\/integer><key>Minute<\/key><integer>0<\/integer>/);
  assert.match(p, /<key>Hour<\/key><integer>18<\/integer>/);
  assert.match(p, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.match(p, /<key>LowPriorityIO<\/key><true\/>/);
  assert.ok(!/RunAtLoad<\/key><true/.test(p) && !/KeepAlive/.test(p), "runs at the set times only");
});

console.log(`\nall ${pass} linkedin checks passed`);
