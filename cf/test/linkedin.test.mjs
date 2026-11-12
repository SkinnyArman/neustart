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
  const prog = [];
  const r = await L.run(cfg, { ...h.deps, progress: (p) => prog.push({ ...p }) });
  await ok("searches only, and after each one hands the new jobs straight to the bot", () => {
    const searches = h.calls.filter((u) => u.includes("seeMoreJobPostings"));
    assert.equal(searches.length, 4); assert.equal(h.calls.length, 4);              // no job pages
    assert.ok(searches.every((u) => /f_TPR=r604800/.test(u) && !/cookie/i.test(u)));   // first run: the past week
    const add = h.posted.filter((p) => p.op === "add");
    assert.equal(add.length, 1, "the same jobs in later searches aren't handed in twice");
    assert.ok(add[0].jobs.every((j) => j.source === "LinkedIn" && /^li:\d+$/.test(j.id)));
    assert.equal(add[0].jobs.find((j) => j.id === "li:101").url, "https://www.linkedin.com/jobs/view/101");
    assert.equal(r.status, "done");
  });
  await ok("progress: searches done, found, handed to the bot", () => {
    assert.deepEqual(prog[0], { done: 0, total: 4, found: 0, handed: 0 });
    assert.equal(prog.at(-1).done, 4); assert.ok(prog.at(-1).handed >= 1);
  });
  await ok("gentle: 60-90 s between LinkedIn requests, at most 10 a run", () => {
    assert.equal(h.waits.length, h.calls.length - 1);
    assert.ok(h.waits.every((ms) => ms >= 60000 && ms <= 90000));
    assert.ok(h.calls.length <= 10);
  });
}
{
  const h = harness({ unknown: [] });
  await L.run(cfg, h.deps);
  await ok("nothing new: nothing handed in", () => assert.equal(h.posted.filter((p) => p.op === "add").length, 0));
}
{
  const h = harness({ limitAt: 2 });
  const r = await L.run(cfg, h.deps);
  await ok("LinkedIn says 'too many requests': stops at once, and what the first search found is with the bot already", () => {
    assert.equal(h.calls.length, 2);
    assert.equal(r.status, "limited");
    assert.equal(h.posted.filter((p) => p.op === "add").length, 1); assert.ok(r.new >= 1);
    assert.equal(JSON.parse(readFileSync(h.deps.state, "utf8")).lastResult, "limited");
  });
}
await ok("how far back: since the last run, at least a day, at most a week", () => {
  const t = Date.UTC(2026, 10, 12, 12);
  assert.equal(L.lookBack(undefined, t), 604800);
  assert.equal(L.lookBack(t - 3 * 3600_000, t), 86400);
  assert.equal(L.lookBack(t - 3 * 86400_000, t), 3 * 86400 + 3600);
  assert.equal(L.lookBack(t - 30 * 86400_000, t), 604800);
});
await ok("jobs switched off in the config, or no secret: nothing is fetched", async () => {
  const h = harness();
  assert.equal((await L.run(normalize({ ...CONFIG, modules: { ...CONFIG.modules, jobs: false } }), h.deps)).status, "off");
  assert.equal((await L.run(cfg, { ...h.deps, env: {} })).status, "no secret");
  assert.equal(h.calls.length, 0);
});


console.log(`\nall ${pass} linkedin checks passed`);
