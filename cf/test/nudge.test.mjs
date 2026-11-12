// The daily nudge (src/nudge.ts): when it goes out, which line fits, the text.
import assert from "node:assert/strict";
import { CONFIG } from "./fixtures/config.mjs";
const SRC = new URL("../src/", import.meta.url).pathname;
const N = await import(SRC + "nudge.ts");
const { normalize } = await import(SRC + "config.ts");
let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ✓", name); };

const cfg = normalize({ ...CONFIG, jobs: { ...CONFIG.jobs, nudge: { person: "diba", mention: "@someone", at: "10:00" } } });
const job = (id, status, extra = {}) => ({ id, title: "Werkstudent Data Analyst", person: "diba", status, kind: null,
  facts: JSON.stringify({ kind: "werkstudent" }), applied_at: null, replied_at: null, ...extra });
const world = (rows) => {
  const kv = new Map(), sent = [];
  return {
    kv, sent,
    db: { prepare: () => ({ all: async () => ({ results: rows }) }) },
    store: { kvGet: async (k) => kv.get(k) ?? null, kvSet: async (k, v) => { kv.set(k, v); } },
    tg: { send: async (text, opts) => { sent.push({ text, opts }); return { result: { message_id: 1 } }; } },
  };
};
const at = (iso) => { Date.now = () => Date.parse(iso); };          // UTC; Berlin is +1 in November
cfg.topics = { ...cfg.topics, jobs: 965 };

console.log("\nthe lines");
await ok("every line has a mention spot, an id of its own, and a quote has its artist", () => {
  assert.equal(new Set(N.LINES.map((l) => l.id)).size, N.LINES.length);
  for (const l of N.LINES) { assert.match(l.text, /\{m\}/, l.id); if (l.quote) assert.ok(l.artist, l.id); }
  assert.ok(N.LINES.length >= 60, String(N.LINES.length));
});
await ok("the message: the line · artist, the nudge with the mention, then what's waiting", () => {
  const t = N.nudgeText(N.LINES.find((l) => l.id === "lift"), "@someone", { fresh: 2, later: 1 });
  assert.equal(t, '🎧 <i>"Today is the first day of the rest of your days, so lighten up, squirt"</i> · Radiohead\n\nMorning @someone 🌱 one application today is plenty.\n\n📋 3 career jobs waiting (2 new, 1 on your waiting list) · /waitinglist');
  assert.match(N.nudgeText(N.LINES.find((l) => l.id === "inbox"), "@x", { fresh: 1, later: 0 }), /^😄 Somewhere in Berlin[\s\S]*📋 1 career job waiting \(1 new\)/);
});
await ok("the line fits the day: a rejection, a pile on the waiting list, a quiet stretch, a Monday", () => {
  const pick = (ctx) => N.pickLine({ rejected: false, monday: false, pile: false, quiet: false, ...ctx }, []);
  for (let i = 0; i < 20; i++) {
    assert.ok(pick({ rejected: true }).when.includes("R"));
    assert.ok(pick({ pile: true }).when.includes("P"));
    assert.ok(pick({ quiet: true }).when.includes("S"));
    assert.ok(pick({ monday: true }).when.includes("M"));
    assert.ok(pick({ only: "F" }).when.includes("F"));
  }
});
await ok("no line twice until all of a kind have had their turn", () => {
  const used = [], ctx = { rejected: false, monday: false, pile: false, quiet: false, only: "F" };
  const funny = N.LINES.filter((l) => l.when?.includes("F")).length;
  for (let i = 0; i < funny; i++) used.push(N.pickLine(ctx, used).id);
  assert.equal(new Set(used).size, funny);
});

console.log("\nwhen it goes out");
{
  const w = world([job("a", "posted"), job("b", "approved"), job("c", "posted", { facts: JSON.stringify({ kind: "part-time" }) })]);
  at("2026-11-12T08:30:00Z");                                         // 09:30 in Berlin
  await ok("not before 10:00 Berlin time", async () => assert.equal(await N.nudgeStep(w.db, w.store, w.tg, cfg), ""));
  at("2026-11-12T09:03:00Z");                                         // 10:03
  await ok("from 10:00: once, in the jobs topic, counting career jobs only (not the part-time one)", async () => {
    assert.match(await N.nudgeStep(w.db, w.store, w.tg, cfg), /^nudge: sent/);
    assert.equal(w.sent.length, 1); assert.equal(w.sent[0].opts.message_thread_id, 965);
    assert.match(w.sent[0].text, /@someone/); assert.match(w.sent[0].text, /📋 2 career jobs waiting \(1 new, 1 on your waiting list\)/);
  });
  at("2026-11-12T15:03:00Z");
  await ok("…and not again that day", async () => { assert.equal(await N.nudgeStep(w.db, w.store, w.tg, cfg), ""); assert.equal(w.sent.length, 1); });
  at("2026-11-13T09:13:00Z");
  await ok("the next day, again - a different line", async () => {
    await N.nudgeStep(w.db, w.store, w.tg, cfg);
    assert.equal(w.sent.length, 2); assert.notEqual(w.sent[0].text, w.sent[1].text);
  });
}
{
  at("2026-11-12T09:03:00Z");
  const today = Math.floor(Date.parse("2026-11-12T07:00:00Z") / 1000);    // 08:00 in Berlin, this morning
  const w = world([job("a", "posted"), job("d", "applied", { applied_at: today })]);
  await ok("not when she applied to a career job today already", async () => {
    assert.equal(await N.nudgeStep(w.db, w.store, w.tg, cfg), "nudge: applied today already"); assert.equal(w.sent.length, 0);
  });
  const w2 = world([job("c", "posted", { facts: JSON.stringify({ kind: "part-time" }) })]);
  await ok("not when there's no career job to apply to", async () => {
    assert.equal(await N.nudgeStep(w2.db, w2.store, w2.tg, cfg), "nudge: nothing to apply to"); assert.equal(w2.sent.length, 0);
  });
  const w3 = world([job("a", "posted"), job("r", "rejected", { replied_at: today, applied_at: today - 9 * 86400 })]);
  await ok("the day after a rejection: a 'rejections don't stop me' line", async () => {
    await N.nudgeStep(w3.db, w3.store, w3.tg, cfg);
    const id = JSON.parse(w3.kv.get("nudge_used"))[0];
    assert.ok(N.LINES.find((l) => l.id === id).when.includes("R"), id);
  });
}
{
  at("2026-11-12T06:00:00Z");                                         // 07:00: before the time, and applied today
  const w = world([job("a", "posted")]);
  w.kv.set("nudge_now", "funny");
  await ok("kv nudge_now=funny: one of our own jokes right away, whatever the time; then cleared", async () => {
    await N.nudgeStep(w.db, w.store, w.tg, cfg);
    assert.equal(w.sent.length, 1); assert.match(w.sent[0].text, /^😄 /);
    assert.equal(w.kv.get("nudge_now"), "0"); assert.equal(w.kv.get("nudge_day"), undefined, "today's own nudge still comes");
  });
}
await ok("without a person and a mention in the config: off", async () => {
  const w = world([job("a", "posted")]);
  assert.equal(await N.nudgeStep(w.db, w.store, w.tg, normalize(CONFIG)), ""); assert.equal(w.sent.length, 0);
});
console.log(`\nall ${pass} nudge checks passed`);
