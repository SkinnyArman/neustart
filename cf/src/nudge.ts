// A daily nudge in the jobs topic: apply to one career-centered job a day.
// Gentle, with a lyric line (or a joke) and the real number waiting. It goes
// out once a day from jobs.nudge.at (Berlin time), only when there's
// something to apply to and nothing career-centered was applied to yet that
// day. The line fits the day: after a rejection, a Monday, a pile on the
// waiting list, a quiet stretch - otherwise any; no line twice until all
// have been used.
//
//   jobs:
//     nudge: { person: diba, mention: "@her_username", at: "10:00" }
//
// kv nudge_now=1 (or =funny): one now, whatever the day says.

import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import { esc, inTopic, type Telegram } from "./telegram.ts";
import { topicOf } from "./topics.ts";
import { isCareer, type JobRow } from "./jobs.ts";

// when: R after a rejection · M a Monday · P a pile on the waiting list ·
// S a quiet stretch · F a joke of our own · X cheeky. Every line can go any day.
type When = "R" | "M" | "P" | "S" | "F" | "X";
export interface Line { id: string; quote?: string; artist?: string; icon: string; text: string; when?: When[] }

/** {m}: the mention. The line, who it's by, then the nudge. */
export const LINES: Line[] = [
  { id: "lift", icon: "🎧", quote: "Today is the first day of the rest of your days, so lighten up, squirt", artist: "Radiohead", text: "Morning {m} 🌱 one application today is plenty.", when: ["M"] },
  { id: "rightplace", icon: "🎧", quote: "Everything in its right place", artist: "Radiohead", text: "Almost, {m}. One application and it will be 😌" },
  { id: "nosurprises", icon: "🎧", quote: "No alarms and no surprises, please", artist: "Radiohead", text: "Just a calm one-application day, {m} ☕", when: ["S"] },
  { id: "creep", icon: "🎧", quote: "What the hell am I doing here?", artist: "Radiohead", text: "Applying, {m}. That's what 😄" },
  { id: "karma", icon: "🎧", quote: "Karma police, arrest this man", artist: "Radiohead", text: "…and this waiting list 🚓 Send one off today, {m}.", when: ["P"] },
  { id: "highhopes", icon: "🎧", quote: "Had to have high, high hopes for a living", artist: "Panic! at the Disco", text: "High hopes, one application, {m} 💛" },
  { id: "lookma", icon: "🎧", quote: "Hey look ma, I made it", artist: "Panic! at the Disco", text: "Future you will say this, {m}. Step one: one application 🌱", when: ["M"] },
  { id: "ride", icon: "🎧", quote: "I'm falling, so I'm taking my time on my ride", artist: "Twenty One Pilots", text: "No rush {m}, just one today 🙂", when: ["S"] },
  { id: "carradio", icon: "🎧", quote: "I ponder of something great", artist: "Twenty One Pilots", text: "Something great might be in the list today, {m} 💭" },
  { id: "stressed", icon: "🎧", quote: "We're stressed out", artist: "Twenty One Pilots", text: "Valid. Still: one application, {m} 🫠", when: ["S"] },
  { id: "wicked", icon: "🎧", quote: "Ain't no rest for the wicked, money don't grow on trees", artist: "Cage the Elephant", text: "True though 😄 one application today, {m}." },
  { id: "mine", icon: "🎧", quote: "My love, mine, all mine", artist: "Mitski", text: "Your CV is all yours too, and it's good {m} 💛" },
  { id: "nobody", icon: "🎧", quote: "Nobody, nobody, nobody", artist: "Mitski", text: "…has applied today yet. Let's change that, {m} 😌", when: ["S"] },
  { id: "notbow", icon: "🎧", quote: "I will not bow, I will not break", artist: "Breaking Benjamin", text: "That's the spirit, {m} 💪", when: ["R"] },
  { id: "jane", icon: "🎧", quote: "If I had to, I would put myself right beside you", artist: "Breaking Benjamin", text: "Your CV, right beside the hiring manager's coffee ☕ {m}" },
  { id: "hail", icon: "🎧", quote: "Hail to the king", artist: "Avenged Sevenfold", text: "…or queen 👑 the jobs are waiting for their ruler, {m}.", when: ["P"] },
  { id: "nightmare", icon: "🎧", quote: "Now your nightmare comes to life", artist: "Avenged Sevenfold", text: "HR's nightmare: a great application from you, {m} 😈" },
  { id: "shoveit", icon: "🎧", quote: "Shove it, shove it, shove it", artist: "Deftones", text: "That's for any rejection 😤 Now one new application, {m}.", when: ["R"] },
  { id: "buddyholly", icon: "🎧", quote: "Oo-ee-oo, I look just like Buddy Holly", artist: "Weezer", text: "And you look just like a hire, {m} 🤓" },
  { id: "aintso", icon: "🎧", quote: "Say it ain't so", artist: "Weezer", text: "…the waiting list is growing 😱 one application today, {m}.", when: ["P"] },
  { id: "hiphip", icon: "🎧", quote: "Hip hip", artist: "Weezer", text: "Hip hip, one application today, {m} 🏝️" },
  { id: "beverly", icon: "🎧", quote: "Beverly Hills, that's where I want to be", artist: "Weezer", text: "Berlin, actually. One application at a time, {m} 🌴➡️🇩🇪" },
  { id: "america", icon: "🎧", quote: "This is America", artist: "Childish Gambino", text: "This is Germany: apply, then wait for a letter 📬😄 {m}" },
  { id: "3005", icon: "🎧", quote: "No matter what, you'll never be alone", artist: "Childish Gambino", text: "Plenty of jobs keeping you company, {m} 💛", when: ["P"] },
  { id: "stronger", icon: "🎧", quote: "That that don't kill me can only make me stronger", artist: "Kanye West", text: "Rejections included 💪 one application today, {m}.", when: ["R"] },
  { id: "sky", icon: "🎧", quote: "Touch the sky", artist: "Kanye West", text: "Or at least touch the \"Apply\" button, {m} ☁️" },
  { id: "bodak", icon: "🎤", quote: "I don't dance now, I make money moves", artist: "Cardi B", text: "Money move of the day: one application, {m} 💸" },
  { id: "workit", icon: "🎤", quote: "Is it worth it? Let me work it", artist: "Missy Elliott", text: "It is worth it, {m} 😌" },
  { id: "truthhurts", icon: "🎤", quote: "Why men great 'til they gotta be great?", artist: "Lizzo", text: "Companies too 🙄 Show them how it's done, {m}.", when: ["R"] },
  { id: "juice", icon: "🎤", quote: "If I'm shinin', everybody gonna shine", artist: "Lizzo", text: "Shine on one application today, {m} ✨" },
  { id: "superbass", icon: "🎤", quote: "Boom badoom boom", artist: "Nicki Minaj", text: "That's the sound of you hitting \"send\", {m} 🔊" },
  { id: "starships", icon: "🎤", quote: "Starships were meant to fly", artist: "Nicki Minaj", text: "So were applications, {m} 🚀" },
  { id: "savage", icon: "🎤", quote: "Classy, bougie, ratchet", artist: "Megan Thee Stallion", text: "Interview mode: classy only 😌 First, one application, {m}." },
  { id: "sayso", icon: "🎤", quote: "Why don't you say so?", artist: "Doja Cat", text: "Want the job? Say so in an application, {m} 💌" },
  { id: "pushit", icon: "🎤", quote: "Push it real good", artist: "Salt-N-Pepa", text: "One application, pushed real good, {m} 🟢" },
  { id: "noscrubs", icon: "🎤", quote: "No, I don't want no scrubs", artist: "TLC", text: "No scrub companies either. Pick a good one, {m} 💅", when: ["P"] },
  // city songs, turned German
  { id: "newyork", icon: "🎧", quote: "If I can make it there, I'll make it anywhere", artist: "Frank Sinatra", text: "If you can make it in Cottbus, you'll make it anywhere 😎 one application, {m}." },
  { id: "empire", icon: "🎧", quote: "Concrete jungle where dreams are made of", artist: "Jay-Z & Alicia Keys", text: "Plattenbau jungle where Werkstudent dreams are made of 🏢 {m}" },
  { id: "welcomeny", icon: "🎧", quote: "Welcome to New York, it's been waiting for you", artist: "Taylor Swift", text: "Willkommen in Berlin, es hat auf dich gewartet 🐻 one application today, {m}.", when: ["M"] },
  { id: "smalltown", icon: "🎧", quote: "Just a small town girl, living in a lonely world", artist: "Journey", text: "Small-town girl in Cottbus, big-city applications 🚆 {m}" },
  { id: "callove", icon: "🎧", quote: "California love", artist: "2Pac", text: "Brandenburg love 💚 Show it with one application today, {m}." },
  { id: "calgurls", icon: "🎧", quote: "California girls, we're unforgettable", artist: "Katy Perry", text: "Cottbus girls, unvergesslich ✨ one application, {m}." },
  { id: "oldtown", icon: "🎧", quote: "I'm gonna take my horse to the old town road", artist: "Lil Nas X", text: "Take your laptop to the Altmarkt café and apply ☕🐎 {m}" },
  { id: "usa", icon: "🎧", quote: "Born in the U.S.A.", artist: "Bruce Springsteen", text: "Hired in the BRD (soon) 🇩🇪 one application today, {m}." },
  { id: "lcd", icon: "🎧", quote: "New York, I love you, but you're bringing me down", artist: "LCD Soundsystem", text: "Deutsche Bahn, I love you, but you're bringing me down 🚆😩 Apply from the train, {m}.", when: ["S"] },
  { id: "hotelcal", icon: "🎧", quote: "Welcome to the Hotel California", artist: "Eagles", text: "Willkommen im Hotel Brandenburg, such a lovely place ✨ one application, {m}." },
  { id: "partyusa", icon: "🎧", quote: "So I put my hands up, they're playing my song", artist: "Miley Cyrus", text: "Hands up: it's a party in the BRD and the interview invite is your song 🎶 {m}" },
  // jokes of our own
  { id: "inbox", icon: "😄", text: "Somewhere in Berlin, a hiring manager is refreshing their inbox hoping it's you. Don't leave them hanging, {m}.", when: ["F"] },
  { id: "odds", icon: "😄", text: "Fun fact: a job you don't apply to has a 0% chance of saying yes. Let's improve the odds, {m} 📈", when: ["F", "S"] },
  { id: "evict", icon: "😄", text: "The waiting list is getting too comfortable, {m}. Evict one job today, by applying 🏠➡️📨", when: ["F", "P"] },
  { id: "cvcalled", icon: "😄", text: "Your CV called. It's bored and wants to go out today, {m} 📄💃", when: ["F", "S"] },
  { id: "behoerde", icon: "😄", text: "One application a day keeps the Ausländerbehörde stress away. (Mostly.) {m} 🇩🇪", when: ["F"] },
  { id: "news", icon: "😄", text: "Breaking news: local data scientist sends one (1) application, economy recovers 📰 {m}", when: ["F"] },
  { id: "workout", icon: "😄", text: "Today's workout: one application. No gym needed, {m} 🏋️‍♀️", when: ["F"] },
  { id: "meeting", icon: "😄", text: "The jobs in your list held a meeting. They all want to be picked first. Choose one, {m} 🗳️", when: ["F", "P"] },
  { id: "plottwist", icon: "😄", text: "Plot twist: today's application is the one. You won't know unless you send it, {m} 🎬", when: ["F"] },
  // cheeky
  { id: "wap", icon: "💦", quote: "Wet-ass p*ssy", artist: "Cardi B & Megan Thee Stallion", text: "W.A.P. = Werkstudent Application, Pronto 📨 {m}", when: ["X"] },
  { id: "anaconda", icon: "🐍", quote: "My anaconda don't want none unless you got buns, hun", artist: "Nicki Minaj", text: "My anaconda don't want none unless you got a Werkstudentenvertrag, hun 📝 One application today, {m}.", when: ["X"] },
  { id: "body", icon: "🍑", quote: "Body-ody-ody", artist: "Megan Thee Stallion", text: "CV-ody-ody-ody 📄🔥 Send one off today, {m}.", when: ["X"] },
  { id: "dna", icon: "🧬", quote: "I just took a DNA test, turns out I'm 100% that b*tch", artist: "Lizzo", text: "DNA test results: 100% that applicant 💅 One today, {m}.", when: ["X"] },
  { id: "cantf", icon: "💅", quote: "Little b*tch, you can't f*ck with me", artist: "Cardi B", text: "That's what you say to rejections 😤 Now one fresh application, {m}.", when: ["X", "R"] },
  { id: "sm", icon: "🔗", quote: "Sticks and stones may break my bones, but chains and whips excite me", artist: "Rihanna", text: "Sticks and stones may break my bones, but Absagen don't scare me 💪 One application, {m}.", when: ["X", "R"] },
  { id: "movebitch", icon: "🚗", quote: "Move, b*tch, get out the way", artist: "Ludacris", text: "That's what your application says to the other candidates 😤 Send one today, {m}.", when: ["X"] },
  { id: "sticky", icon: "🧽", quote: "Better find a mop, it's gettin' sticky in this b*tch", artist: "Tyler, the Creator ft. GloRilla", text: "Better find a mop: your waiting list is overflowing 🫠 Clean up one with an application today, {m}.", when: ["X", "P"] },
];

/** The message: the line and who it's by, the nudge, then what's waiting. */
export function nudgeText(l: Line, mention: string, waiting: { fresh: number; later: number }): string {
  const n = waiting.fresh + waiting.later;
  const what = [waiting.fresh ? `${waiting.fresh} new` : "", waiting.later ? `${waiting.later} on your waiting list` : ""].filter(Boolean).join(", ");
  return [
    l.quote ? `${l.icon} <i>"${esc(l.quote)}"</i> · ${esc(l.artist ?? "")}\n\n${esc(l.text).replace("{m}", esc(mention))}` : `${l.icon} ${esc(l.text).replace("{m}", esc(mention))}`,
    `📋 ${n} career job${n === 1 ? "" : "s"} waiting (${what}) · /waitinglist`,
  ].join("\n\n");
}

/** The fitting lines for today, freshest first; one not used lately, at random. */
export function pickLine(ctx: { rejected: boolean; monday: boolean; pile: boolean; quiet: boolean; only?: When },
  used: string[], rnd: () => number = Math.random): Line {
  const want: When | null = ctx.only ?? (ctx.rejected ? "R" : ctx.pile ? "P" : ctx.quiet ? "S" : ctx.monday ? "M" : null);
  const unused = (ls: Line[]) => { const u = ls.filter((l) => !used.includes(l.id)); return u.length ? u : ls; };
  const pool = unused(want ? LINES.filter((l) => l.when?.includes(want)) : LINES);
  return pool[Math.floor(rnd() * pool.length)] ?? LINES[0];
}

const berlin = (t: number) => new Date(t).toLocaleString("sv-SE", { timeZone: "Europe/Berlin" });   // "2026-11-12 10:03:00"

/** One tick: the nudge, if it's time and it fits. */
export async function nudgeStep(db: D1Database, store: Store, tg: Telegram, cfg: Config): Promise<string> {
  const n = cfg.jobs.nudge;
  if (!n?.person || !n.mention) return "";
  const forced = await store.kvGet("nudge_now");
  const now = berlin(Date.now()), today = now.slice(0, 10);
  if (!forced || forced === "0") {
    if (now.slice(11, 16) < n.at || (await store.kvGet("nudge_day")) === today) return "";
  }
  const j = cfg.jobs;
  const mine = (r: JobRow) => (r.person ?? "").split(",").includes(n.person) || r.person === "both" || r.person === "all" || r.person === n.person;
  const { results } = await db.prepare(
    "SELECT * FROM jobs WHERE status IN ('posted','approved','applied','already','interview','rejected','offer','declined','accepted')").all<JobRow>();
  const rows = (results ?? []).filter(mine);
  const career = (r: JobRow) => isCareer(r, j);
  const fresh = rows.filter((r) => r.status === "posted" && career(r)).length;
  const later = rows.filter((r) => r.status === "approved" && career(r)).length;
  // the day starts at midnight in Berlin
  const ahead = Date.parse(now.replace(" ", "T") + "Z") - Date.now();          // Berlin's lead on UTC, in ms
  const midnight = (Date.parse(`${today}T00:00:00Z`) - ahead) / 1000;
  const appliedToday = rows.some((r) => r.applied_at && r.applied_at >= midnight && r.person === n.person && career(r));
  if (!forced || forced === "0") {
    await store.kvSet("nudge_day", today);
    if (!fresh && !later) return "nudge: nothing to apply to";
    if (appliedToday) return "nudge: applied today already";
  } else await store.kvSet("nudge_now", "0");
  const lastApplied = Math.max(0, ...rows.filter((r) => r.applied_at && r.person === n.person).map((r) => r.applied_at!));
  const ctx = {
    rejected: rows.some((r) => r.status === "rejected" && (r.replied_at ?? 0) > Date.now() / 1000 - 2 * 86400),
    monday: new Date(`${today}T12:00:00Z`).getUTCDay() === 1,
    pile: later >= 3,
    quiet: !!lastApplied && Date.now() / 1000 - lastApplied > 3 * 86400,
    only: forced === "funny" ? ("F" as When) : undefined,
  };
  const used: string[] = JSON.parse((await store.kvGet("nudge_used")) ?? "[]");
  const line = pickLine(ctx, used);
  await tg.send(nudgeText(line, n.mention, { fresh, later }), inTopic(await topicOf(cfg, store, tg, "jobs")));
  // remembered until every line has had its turn
  const next = [...used.filter((x) => x !== line.id), line.id];
  await store.kvSet("nudge_used", JSON.stringify(next.length >= LINES.length ? [line.id] : next));
  return `nudge: sent "${line.id}"`;
}
