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
await ok("no line twice until every line has gone out - even when the day keeps asking for the same kind", () => {
  for (const ctx of [{}, { rejected: true }, { pile: true }, { quiet: true }, { monday: true }, { only: "F" }]) {
    const used = [];
    for (let i = 0; i < N.LINES.length; i++) used.push(N.pickLine({ rejected: false, monday: false, pile: false, quiet: false, ...ctx }, used).id);
    assert.equal(new Set(used).size, N.LINES.length, JSON.stringify(ctx));
  }
});
await ok("…the fitting ones first, while any are left", () => {
  const used = [], ctx = { rejected: true, monday: false, pile: false, quiet: false };
  const fit = N.LINES.filter((l) => l.when?.includes("R")).length;
  for (let i = 0; i < fit; i++) used.push(N.pickLine(ctx, used).id);
  assert.ok(used.every((id) => N.LINES.find((l) => l.id === id).when?.includes("R")));
});

console.log("\nwhen it goes out");
{
  const w = world([job("a", "posted"), job("b", "approved"), job("c", "posted", { facts: JSON.stringify({ kind: "part-time" }) })]);
  at("2026-11-12T08:30:00Z");                                         // 09:30 in Berlin
  await ok("not before 10:00 Berlin time", async () => assert.equal(await N.nudgeStep(w.db, w.store, w.tg, cfg), ""));
  at("2026-11-12T09:03:00Z");                                         // 10:03
  await ok("from 10:00: once, in the jobs topic, counting career jobs only (not the part-time one)", async () => {
    assert.match(await N.nudgeStep(w.db, w.store, w.tg, cfg), /^nudge diba: sent/);
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
    assert.equal(await N.nudgeStep(w.db, w.store, w.tg, cfg), "nudge diba: applied today already"); assert.equal(w.sent.length, 0);
  });
  const w2 = world([job("c", "posted", { facts: JSON.stringify({ kind: "part-time" }) })]);
  await ok("not when there's no career job to apply to", async () => {
    assert.equal(await N.nudgeStep(w2.db, w2.store, w2.tg, cfg), "nudge diba: nothing to apply to"); assert.equal(w2.sent.length, 0);
  });
  const w3 = world([job("a", "posted"), job("r", "rejected", { replied_at: today, applied_at: today - 9 * 86400 })]);
  await ok("the day after a rejection: a 'rejections don't stop me' line", async () => {
    await N.nudgeStep(w3.db, w3.store, w3.tg, cfg);
    const id = JSON.parse(w3.kv.get("nudge_used:diba"))[0];
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
    assert.equal(w.kv.get("nudge_now"), "0"); assert.equal(w.kv.get("nudge_day:diba"), undefined, "today's own nudge still comes");
  });
}
{
  const w = world([job("a", "posted"), job("r", "rejected", { replied_at: 2e9, applied_at: 1e9 })]);   // a rejection every day
  const ids = [];
  for (let d = 0; d < N.LINES.length + 1; d++) {
    at(new Date(Date.UTC(2026, 11, 1 + d, 9, 13)).toISOString());
    await N.nudgeStep(w.db, w.store, w.tg, cfg);
    ids.push(JSON.parse(w.kv.get("nudge_used:diba")).at(-1));
  }
  await ok(`${N.LINES.length} days in a row: ${N.LINES.length} different lines, then a new round`, () => {
    assert.equal(w.sent.length, N.LINES.length + 1);
    assert.equal(new Set(ids.slice(0, N.LINES.length)).size, N.LINES.length);
    assert.notEqual(ids.at(-1), ids.at(-2), "not the same twice in a row across rounds");
    assert.equal(JSON.parse(w.kv.get("nudge_used:diba")).length, 2);
  });
}
console.log("\nper person, and /nudge");
{
  const w = world([job("a", "posted")]);
  // Diba's record from before (one nudge for the group) carries over
  w.kv.set("nudge_used", JSON.stringify(["odds", "evict", "hail"])); w.kv.set("nudge_day", "2026-11-14");
  at("2026-11-14T15:00:00Z");
  await ok("the earlier group-wide record carries over to the first person: no second nudge today, no repeats", async () => {
    assert.equal(await N.nudgeStep(w.db, w.store, w.tg, cfg), ""); assert.equal(w.sent.length, 0);
    at("2026-11-15T09:13:00Z"); await N.nudgeStep(w.db, w.store, w.tg, cfg);
    const used = JSON.parse(w.kv.get("nudge_used:diba"));
    assert.deepEqual(used.slice(0, 3), ["odds", "evict", "hail"]); assert.equal(used.length, 4);
  });
  await ok("/nudge card: each person in the config, on/off, time and who's mentioned; buttons for the ones with a mention", async () => {
    const [t, kb] = await N.nudgeCard(w.store, cfg);
    assert.match(t, /Diba<\/b>: on · 10:00 · @someone/);
    assert.match(t, /Arman<\/b>: off · no one to mention yet: \/nudge arman @username/);
    assert.equal(kb.length, 1); assert.deepEqual(kb[0].map((b) => b.text), ["👩‍💻 ⏸ Off", "−30 min", "+30 min", "📨 Now"]);
  });
  await ok("/nudge arman @someoneelse: Arman gets his own, on, at 10:00", async () => {
    assert.match(await N.setNudge(w.db, w.store, w.tg, cfg, "arman", "@someoneelse"), /on, mentioning @someoneelse, at 10:00/);
    const ns = await N.nudgesOf(w.store, cfg);
    assert.deepEqual(ns.map((n) => [n.person, n.on, n.mention, n.at]), [["diba", true, "@someone", "10:00"], ["arman", true, "@someoneelse", "10:00"]]);
  });
  await ok("/nudge diba 9:30 · the −30/+30 buttons · off · on", async () => {
    await N.setNudge(w.db, w.store, w.tg, cfg, "diba", "9:30");
    assert.equal((await N.nudgesOf(w.store, cfg))[0].at, "09:30");
    await N.setNudge(w.db, w.store, w.tg, cfg, "diba", "later"); assert.equal((await N.nudgesOf(w.store, cfg))[0].at, "10:00");
    await N.setNudge(w.db, w.store, w.tg, cfg, "diba", "earlier"); await N.setNudge(w.db, w.store, w.tg, cfg, "diba", "earlier");
    assert.equal((await N.nudgesOf(w.store, cfg))[0].at, "09:00");
    await N.setNudge(w.db, w.store, w.tg, cfg, "diba", "off"); assert.equal((await N.nudgesOf(w.store, cfg))[0].on, false);
    await N.setNudge(w.db, w.store, w.tg, cfg, "diba", "on"); assert.equal((await N.nudgesOf(w.store, cfg))[0].on, true);
  });
  await ok("/nudge diba now: sent at once, whatever the time, without using up today's", async () => {
    const before = w.sent.length; at("2026-11-16T05:00:00Z");
    assert.match(await N.setNudge(w.db, w.store, w.tg, cfg, "diba", "now"), /Sent to Diba/);
    assert.equal(w.sent.length, before + 1); assert.match(w.sent.at(-1).text, /@someone/);
    assert.notEqual(w.kv.get("nudge_day:diba"), "2026-11-16");
  });
  await ok("two people: each gets their own, mentioned by name, once a day", async () => {
    const w2 = world([job("a", "posted"), job("b", "posted", { person: "arman", title: "Werkstudent Frontend React" })]);
    await N.setNudge(w2.db, w2.store, w2.tg, cfg, "arman", "@someoneelse");
    at("2026-11-17T09:13:00Z"); await N.nudgeStep(w2.db, w2.store, w2.tg, cfg); await N.nudgeStep(w2.db, w2.store, w2.tg, cfg);
    assert.equal(w2.sent.length, 2);
    assert.ok(w2.sent.some((s) => /@someone\b/.test(s.text))); assert.ok(w2.sent.some((s) => /@someoneelse/.test(s.text)));
  });
  await ok("an unknown name, or no mention yet: says what to do", async () => {
    assert.match(await N.setNudge(w.db, w.store, w.tg, cfg, "zoe", "on"), /^Try \/nudge diba @username/);
    const w3 = world([]);
    assert.match(await N.setNudge(w3.db, w3.store, w3.tg, normalize(CONFIG), "diba", "9:30"), /First, who to mention: \/nudge diba @username/);
  });
}
await ok("without a person and a mention in the config: off", async () => {
  const w = world([job("a", "posted")]);
  assert.equal(await N.nudgeStep(w.db, w.store, w.tg, normalize(CONFIG)), ""); assert.equal(w.sent.length, 0);
});
console.log(`\nall ${pass} nudge checks passed`);
