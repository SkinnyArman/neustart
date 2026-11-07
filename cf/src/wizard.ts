// /setup: the config, made by answering questions in a private chat with
// the bot - the same config neustart.yaml makes, checked the same way
// (normalize()) before it's stored. For a fresh fork after the one-time
// deploy; the owner only, in private only.
//
// It never touches a working bot by accident: with a config already stored,
// /setup only says so. /setup restart answers everything again (the current
// config is saved first), /setup undo brings the saved one back, /setup
// cancel drops the answers. While a setup is going, plain messages from the
// owner in that private chat are its answers; nothing else changes how the
// bot reads messages.

import { normalize, slugify, type Config } from "./config.ts";
import { findTowns } from "./kleinanzeigen.ts";
import type { Store } from "./store.ts";
import { esc, type Button, type Telegram } from "./telegram.ts";

const KEY = "setup";

interface Answers {
  city?: string; ka?: string; towns?: { name: string; code: string }[];
  modules: Record<string, boolean>;
  r_name?: string; r_age?: number; r_pronouns?: string; r_about?: string[]; r_rent?: number; r_wg?: string;
  f_items: Record<string, boolean>; f_radius?: number;
  people: { name: string; searches: string[]; cv: string }[];
  j_name?: string; j_searches?: string[]; j_cv?: string; j_student?: boolean; j_cities?: string[];
  c_sources: Record<string, boolean>; c_only?: boolean;
  e_kinds: Record<string, boolean>; e_budget?: number;
}
interface State { chat: string; step: string; a: Answers }

const MODULE_LABEL: Record<string, string> = { rooms: "🏠 WG rooms", finds: "🔎 Cheap & free finds", jobs: "💼 Jobs", casual_jobs: "🧺 Minijobs", events: "🎭 Events" };
const ITEM_LABEL: Record<string, string> = { bike: "🚲 Bike", bed: "🛏 Bed", kommode: "🗄 Kommode", carpet: "🧶 Rug", washer: "🧼 Washing machine", chair: "🪑 Desk chair", free: "🎁 Free stuff" };
const SOURCE_LABEL: Record<string, string> = { minijobs: "Minijobs (Jobbörse)", part_time: "Part-time jobs (Jobbörse)", kleinanzeigen: "Nebenjobs (Kleinanzeigen)" };
const KIND_LABEL: Record<string, string> = { culture: "🎭 Cultural events", career: "🎤 Career events" };
const COTTBUS_READERS = ["cottbus_theater", "gladhouse", "cottbus_city"];

const fresh = (): Answers => ({
  modules: { rooms: true, finds: true, jobs: true, casual_jobs: true, events: false },
  f_items: { bike: true, bed: true, kommode: true, carpet: true, washer: false, chair: false, free: true },
  people: [], c_sources: { minijobs: true, part_time: true, kleinanzeigen: true }, e_kinds: { culture: true, career: true },
});

// ---------------------------------------------------------------- the questions
// Each step: the question (text and buttons), and what an answer does.
// next() says which step comes after, skipping the parts of modules that are off.
type Ask = { text: string; buttons?: Button[][] };
const btn = (text: string, data: string): Button => ({ text, callback_data: `su:${data}` });
const multi = (opts: Record<string, string>, on: Record<string, boolean>, done = "Done ✅"): Button[][] => [
  ...Object.entries(opts).map(([k, label]) => [btn(`${on[k] ? "✅" : "⬜"} ${label}`, `t:${k}`)]),
  [btn(done, "done")],
];

const ORDER = ["city", "town", "modules", "r_name", "r_age", "r_pronouns", "r_about", "r_rent", "r_wg",
  "f_items", "f_radius", "j_name", "j_searches", "j_cv", "j_more", "j_student", "j_cities",
  "c_sources", "c_only", "e_kinds", "e_budget", "confirm"];
const PART: Record<string, string> = { r: "rooms", f: "finds", j: "jobs", c: "casual_jobs", e: "events" };

function next(step: string, a: Answers): string {
  for (let i = ORDER.indexOf(step) + 1; i < ORDER.length; i++) {
    const s = ORDER[i];
    if (s === "town" && !(a.towns && a.towns.length > 1)) continue;
    const part = PART[s.split("_")[0]];
    if (part && s.includes("_") && !a.modules[part]) continue;
    return s;
  }
  return "confirm";
}

function ask(step: string, a: Answers): Ask {
  const city = a.city ?? "your city";
  switch (step) {
    case "city": return { text: "👋 Let's set up the bot. A few questions, mostly buttons.\n\n<b>Which city are you moving to?</b> (in Germany - the searches, finds and jobs are around it)" };
    case "town": return { text: `There's more than one ${esc(city)}. <b>Which one?</b>`, buttons: (a.towns ?? []).slice(0, 8).map((t, i) => [btn(t.name, `town:${i}`)]) };
    case "modules": return { text: "<b>What should the bot look for?</b> Tap to switch on or off.", buttons: multi(MODULE_LABEL, a.modules) };
    case "r_name": return { text: "🏠 <b>Rooms.</b> The bot drafts your replies to WG ads, so it needs a little about you.\n\n<b>Your first name?</b>" };
    case "r_age": return { text: "<b>Your age?</b>" };
    case "r_pronouns": return { text: "<b>How should the replies talk about you?</b>", buttons: [[btn("he/him", "p:he/him"), btn("she/her", "p:she/her"), btn("they/them", "p:they/them")]] };
    case "r_about": return { text: "<b>A few short lines about you</b>, one per line, for the replies. For example:\n<i>I'll study Data Science at BTU\nnon-smoker, no pets\nGerman B2, English fluent\nrent is covered by a blocked account\nquiet on weeknights, happy to cook together</i>" };
    case "r_rent": return { text: "<b>Highest rent you'd pay</b>, in euros a month?" };
    case "r_wg": return { text: `The bot searches Kleinanzeigen's WG ads in ${esc(city)} by itself. For WG-Gesucht too, search ${esc(city)} on wg-gesucht.de and <b>paste the address</b> here.`, buttons: [[btn("Skip", "skip")]] };
    case "f_items": return { text: "🔎 <b>Finds.</b> Which cheap or free things should it hunt for? (prices can be changed later with /finds)", buttons: multi(ITEM_LABEL, a.f_items) };
    case "f_radius": return { text: `<b>How far around ${esc(city)}?</b>`, buttons: [[10, 20, 30, 50].map((k) => btn(`${k} km`, `km:${k}`))] };
    case "j_name": return { text: `💼 <b>Jobs.</b> ${a.people.length ? "Next person:" : "Who's looking for a job?"} <b>Their first name?</b>` };
    case "j_searches": return { text: `<b>What should be searched for ${esc(a.j_name ?? "them")}?</b> A few job searches, one per line or with commas. For example:\n<i>Werkstudent Data Analyst, Data Analyst, Business Intelligence</i>` };
    case "j_cv": return { text: `<b>${esc(a.j_name ?? "Their")}'s CV, as text</b> - paste it here (more messages are fine). The bot matches jobs against it and writes cover letters from it. Tap Done when it's all in.`, buttons: [[btn("Done", "done")]] };
    case "j_more": return { text: `Saved ${esc(a.people.map((p) => p.name).join(", "))}. <b>Anyone else looking?</b>`, buttons: [[btn("➕ Add someone", "more"), btn("No, that's all", "done")]] };
    case "j_student": return { text: "<b>Are they on a student residence permit?</b> Then Werkstudent jobs come first and full-time jobs are left out.", buttons: [[btn("Yes", "yes"), btn("No", "no")]] };
    case "j_cities": return { text: `<b>Which cities should jobs be searched in?</b> Comma-separated, or just ${esc(city)}.`, buttons: [[btn(`Just ${city}`, "same")]] };
    case "c_sources": return { text: "🧺 <b>Minijobs.</b> Where from?", buttons: multi(SOURCE_LABEL, a.c_sources) };
    case "c_only": return { text: `<b>Only in ${esc(city)} itself, or the towns around it too?</b>`, buttons: [[btn(`${city} only`, "only"), btn("Around it too (25 km)", "around")]] };
    case "e_kinds": return { text: "🎭 <b>Events.</b> Which ones?" + (slugify(city) === "cottbus" ? "" : `\n\n<i>The cultural-events readers only know Cottbus so far; for ${esc(city)} only career events (hackathons, meetups) can be found.</i>`), buttons: multi(KIND_LABEL, a.e_kinds) };
    case "e_budget": return { text: "<b>Budget for cultural events</b>, in euros? Pricier ones are left out.", buttons: [[btn("10 €", "b:10"), btn("20 €", "b:20"), btn("Any", "b:500")]] };
    case "confirm": return { text: `<b>That's it.</b> Here's your setup:\n\n${esc(summary(build(a)))}\n\nSave it?`, buttons: [[btn("💾 Save", "save"), btn("Start over", "restart"), btn("Cancel", "cancel")]] };
  }
  return { text: "?" };
}

/** A typed answer; an error to show, or null when it was taken. */
async function takeText(step: string, a: Answers, t: string): Promise<string | null> {
  const v = t.trim();
  switch (step) {
    case "city": {
      if (!/^[\p{L} .()'-]{2,60}$/u.test(v)) return "That doesn't look like a town's name - try again?";
      a.city = v.replace(/\s+/g, " ");
      try {
        const towns = await findTowns(a.city, slugify);
        a.towns = towns; a.ka = towns.length === 1 ? towns[0].code : undefined;
        if (!towns.length) return `Kleinanzeigen doesn't know a town called ${a.city} - check the spelling?`;
      } catch { a.towns = []; a.ka = undefined; }          // Kleinanzeigen unreachable: finds and its WG search stay off
      return null;
    }
    case "r_name": case "j_name":
      if (!/^[\p{L} .'-]{1,40}$/u.test(v)) return "Just the first name, please.";
      if (step === "r_name") a.r_name = v; else a.j_name = v;
      return null;
    case "r_age": { const n = Number(v); if (!(n >= 16 && n <= 99)) return "A number, please (like 25)."; a.r_age = Math.round(n); return null; }
    case "r_about": {
      const lines = v.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return "A few lines, please.";
      a.r_about = lines.slice(0, 12); return null;
    }
    case "r_rent": { const n = Number(v.replace(/[€\s]/g, "")); if (!(n >= 100 && n <= 3000)) return "A number of euros, please (like 450)."; a.r_rent = Math.round(n); return null; }
    case "r_wg":
      if (!/^https:\/\/www\.wg-gesucht\.de\/\S+\.html$/.test(v)) return "That isn't a WG-Gesucht search address. Paste the one from your browser, or tap Skip.";
      a.r_wg = v; return null;
    case "j_searches": {
      const s = v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      if (!s.length) return "At least one search, please.";
      a.j_searches = s.slice(0, 10); return null;
    }
    case "j_cv": a.j_cv = `${a.j_cv ? a.j_cv + "\n" : ""}${v}`.slice(0, 8000); return "Got it - more, or tap Done.";
    case "j_cities": {
      const c = v.split(",").map((x) => x.trim()).filter((x) => /^[\p{L} .()'-]{2,40}$/u.test(x));
      if (!c.length) return "Town names, separated by commas.";
      a.j_cities = c.slice(0, 5); return null;
    }
    case "e_budget": { const n = Number(v.replace(/[€\s]/g, "")); if (!(n >= 0 && n <= 500)) return "A number of euros, please."; a.e_budget = n; return null; }
  }
  return "Please use the buttons above.";
}

/** A button; an error, null when the step is done, or "stay" to redraw it. */
function takeButton(step: string, a: Answers, d: string): string | null {
  const [kind, val] = d.split(":");
  const toggle = (on: Record<string, boolean>) => { if (val in on) on[val] = !on[val]; return "stay"; };
  switch (step) {
    case "town": { const t = a.towns?.[Number(val)]; if (!t) return "?"; a.ka = t.code; return null; }
    case "modules": if (kind === "t") return toggle(a.modules); return Object.values(a.modules).some(Boolean) ? null : "Switch on at least one.";
    case "f_items": if (kind === "t") return toggle(a.f_items); return Object.values(a.f_items).some(Boolean) ? null : "Pick at least one.";
    case "c_sources": if (kind === "t") return toggle(a.c_sources); return Object.values(a.c_sources).some(Boolean) ? null : "Pick at least one.";
    case "e_kinds": if (kind === "t") return toggle(a.e_kinds); return Object.values(a.e_kinds).some(Boolean) ? null : "Pick at least one.";
    case "r_pronouns": if (kind !== "p") return "?"; a.r_pronouns = val; return null;
    case "r_wg": if (kind !== "skip") return "?"; return null;
    case "f_radius": if (kind !== "km") return "?"; a.f_radius = Number(val); return null;
    case "j_cv":
      if (!a.j_cv || a.j_cv.length < 40) return "Paste the CV first - a few lines at least.";
      a.people.push({ name: a.j_name!, searches: a.j_searches!, cv: a.j_cv });
      a.j_name = a.j_searches = a.j_cv = undefined;
      return null;
    case "j_student": a.j_student = kind === "yes"; return null;
    case "j_cities": if (kind !== "same") return "?"; a.j_cities = [a.city!]; return null;
    case "c_only": a.c_only = kind === "only"; return null;
    case "e_budget": if (kind !== "b") return "?"; a.e_budget = Number(val); return null;
  }
  return "?";
}

// ---------------------------------------------------------------- the config
/** The answers as a config - what neustart.yaml would say. */
export function build(a: Answers): Record<string, any> {
  const m = a.modules, city = a.city ?? "";
  const cottbus = slugify(city) === "cottbus";
  const rooms = m.rooms ? {
    about: { name: a.r_name, age: a.r_age, pronouns: a.r_pronouns ?? "they/them", always: a.r_about ?? [],
      never: ["Never invent facts, jobs, budgets or references.", "Never use emojis."] },
    style: { length: "90-120 words", tone: "Friendly, warm and relaxed - writing to people they'd like to live with, not to a landlord.", sign_off: a.r_name },
    searches: [
      ...(a.ka ? [{ name: `Kleinanzeigen ${city}`, url: `https://www.kleinanzeigen.de/s-auf-zeit-wg/${a.ka.split("/")[0]}/anzeige:angebote/c199${a.ka.split("/")[1]}`, hot: true }] : []),
      ...(a.r_wg ? [{ name: `WG-Gesucht ${city}`, url: a.r_wg, hot: true }] : []),
    ],
    // a woman isn't kept from rooms for women
    filters: { max_rent: a.r_rent ?? 600, skip_female_only: !/^she/.test(a.r_pronouns ?? ""), skip_pendler: true },
  } : {};
  const people = a.people.map((p) => ({ name: p.name, searches: p.searches, summary: p.cv.slice(0, 600), cv: p.cv }));
  return {
    city, ...(a.ka ? { kleinanzeigen: a.ka } : {}),
    modules: { ...m }, topics: "auto", rooms,
    finds: { radius_km: a.f_radius ?? 30, items: Object.fromEntries(Object.entries(a.f_items).map(([k, on]) => [k, { on }])) },
    jobs: { student_permit: a.j_student ?? false, cities: (a.j_cities ?? [city]).map((name) => ({ name, radius_km: 50 })), people },
    casual_jobs: { radius_km: 25, only_city: a.c_only ?? false, sources: Object.keys(a.c_sources).filter((k) => a.c_sources[k]), worth_it: true },
    events: { culture: a.e_kinds.culture && cottbus, career: a.e_kinds.career, max_price: a.e_budget ?? 10,
      sources: [...(cottbus ? [...COTTBUS_READERS, "btu"] : []), "devpost"] },
  };
}

function summary(raw: Record<string, any>): string {
  const c: Config = normalize(raw);
  const on = Object.entries(c.modules).filter(([, v]) => v).map(([k]) => MODULE_LABEL[k] ?? k);
  return [
    `City: ${c.city}`,
    `Looking for: ${on.join(", ") || "nothing"}`,
    ...(c.modules.rooms ? [`Rooms: up to ${c.rooms.filters.max_rent} €, ${c.rooms.searches.length} search${c.rooms.searches.length === 1 ? "" : "es"}`] : []),
    ...(c.modules.finds ? [`Finds within ${c.finds.radius_km} km: ${Object.entries(c.finds.items).filter(([, i]) => i.on).map(([k]) => ITEM_LABEL[k]).join(", ")}`] : []),
    ...(c.modules.jobs ? [`Jobs for ${c.jobs.people.map((p) => p.name).join(", ")} in ${c.jobs.cities.map((x) => x.name).join(", ")}${c.jobs.student_permit ? " (student permit)" : ""}`] : []),
    ...(c.modules.casual_jobs ? [`Minijobs: ${c.casual_jobs.only_city ? `${c.city} only` : "25 km around"}`] : []),
    ...(c.modules.events ? [`Events: ${[c.events.culture ? `cultural up to ${c.events.max_price} €` : "", c.events.career ? "career" : ""].filter(Boolean).join(", ")}`] : []),
    ...c.problems.map((p) => `⚠️ ${p}`),
  ].join("\n");
}

// ---------------------------------------------------------------- the conversation
const load = async (store: Store): Promise<State | null> => { const r = await store.kvGet(KEY); try { return r ? JSON.parse(r) : null; } catch { return null; } };
const save = (store: Store, s: State | null) => store.kvSet(KEY, s ? JSON.stringify(s) : "");

/** Is a setup going on in this chat? (then plain messages there are its answers) */
export const setupActive = async (store: Store, chat: string) => (await load(store))?.chat === chat;

const show = async (tg: Telegram, s: State) => {
  const q = ask(s.step, s.a);
  await tg.send(q.text, q.buttons ? tg.keyboard(q.buttons) : {}, s.chat);
};

/** /setup, /setup restart, /setup undo, /setup cancel - the owner, in private. */
export async function setupCommand(store: Store, tg: Telegram, msg: any, args: string[]): Promise<void> {
  const chat = String(msg.chat.id);
  if (msg.chat.type !== "private") { await tg.send("Let's do this in private: open a chat with me and send /setup there.", {}, chat); return; }
  const sub = (args[0] ?? "").toLowerCase();
  const current = await store.kvGet("config");
  if (sub === "cancel") { await save(store, null); await tg.send("Setup cancelled. Nothing was changed.", {}, chat); return; }
  if (sub === "undo") {
    const backup = await store.kvGet("config_backup");
    if (!backup) { await tg.send("There's no earlier setup to go back to.", {}, chat); return; }
    await store.kvSet("config", backup); await store.kvSet("config_backup", current ?? "");
    await tg.send("↩️ Back to the setup from before. (/setup undo again swaps them back.)", {}, chat);
    return;
  }
  const going = await load(store);
  if (going && going.chat === chat && sub !== "restart") { await show(tg, going); return; }
  if (current && sub !== "restart") {
    let city = "";
    try { city = normalize(JSON.parse(current)).city; } catch { /* unreadable */ }
    await tg.send(`The bot is already set up${city ? ` for ${esc(city)}` : ""}.\n\n/setup restart answers everything again - the current setup is saved first, and /setup undo brings it back.`, {}, chat);
    return;
  }
  const s: State = { chat, step: "city", a: fresh() };
  await save(store, s);
  await show(tg, s);
}

/** A plain message in the setup's chat. */
export async function setupAnswer(store: Store, tg: Telegram, msg: any): Promise<void> {
  const s = await load(store);
  if (!s) return;
  const err = await takeText(s.step, s.a, String(msg.text ?? ""));
  if (err) {
    await save(store, s);                                 // a CV part is kept even with "more, or Done"
    await tg.send(err, {}, s.chat);
    return;
  }
  s.step = next(s.step, s.a);
  await save(store, s);
  await show(tg, s);
}

/** A button on a setup question (su:…). */
export async function setupButton(store: Store, tg: Telegram, cq: any): Promise<void> {
  const s = await load(store);
  const d = String(cq.data).slice(3);
  if (!s) { await tg.answerCallback(cq.id, "No setup going on - send /setup"); return; }
  if (s.step === "confirm") {
    if (d === "cancel") { await save(store, null); await tg.answerCallback(cq.id, "Cancelled"); await tg.send("Setup cancelled. Nothing was changed.", {}, s.chat); return; }
    if (d === "restart") { const r: State = { chat: s.chat, step: "city", a: fresh() }; await save(store, r); await tg.answerCallback(cq.id); await show(tg, r); return; }
    if (d === "save") {
      const raw = build(s.a);
      const c = normalize(raw);
      if (c.problems.length) { await tg.answerCallback(cq.id, "Something's missing", true); await tg.send(`Can't save yet:\n${c.problems.map((p) => `• ${esc(p)}`).join("\n")}\n\nTap Start over to fix it.`, {}, s.chat); return; }
      const old = await store.kvGet("config");
      if (old) await store.kvSet("config_backup", old);
      await store.kvSet("config", JSON.stringify(raw));
      await save(store, null);
      await tg.answerCallback(cq.id, "Saved");
      await tg.send(`✅ <b>Saved.</b> The bot starts with its next round (within a few minutes). In the group, type / to see the commands.` +
        (old ? "\n\n/setup undo brings back the setup from before." : ""), {}, s.chat);
      return;
    }
  }
  // "add someone": back to the next person's name
  if (s.step === "j_more") {
    await tg.answerCallback(cq.id);
    try { await tg.clearKeyboard(cq.message.chat.id, cq.message.message_id); } catch { /* old message */ }
    s.step = d === "more" ? "j_name" : next("j_more", s.a);
    await save(store, s);
    await show(tg, s);
    return;
  }
  const err = takeButton(s.step, s.a, d);
  if (err === "stay") {
    await save(store, s);
    await tg.answerCallback(cq.id);
    const q = ask(s.step, s.a);
    try { await tg.editMarkup(cq.message.chat.id, cq.message.message_id, q.buttons ?? []); } catch { /* unchanged */ }
    return;
  }
  if (err) { await tg.answerCallback(cq.id, err, true); return; }
  await tg.answerCallback(cq.id);
  try { await tg.clearKeyboard(cq.message.chat.id, cq.message.message_id); } catch { /* old message */ }
  s.step = next(s.step, s.a);
  await save(store, s);
  await show(tg, s);
}
