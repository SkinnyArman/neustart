// Is every search still working? Each one notes here when it worked and how
// many results it read (kv health:<source>). Once an hour a check looks for
// a source that hasn't worked for 12 hours, or keeps reading empty pages
// (what a changed page layout looks like). A problem has to be there at two
// checks in a row before the group hears of it - then exactly once, and once
// more when it works again. Nothing in between: no reminders, no spam.
//
// Sources that already send their own message for a long block (the room
// search's sites, the finds) are left to it while they're backing off.

import type { Config } from "./config.ts";
import { blockSecondsLeft, pauseState } from "./settings.ts";
import type { Store } from "./store.ts";
import { esc, type Telegram } from "./telegram.ts";

export type Source = "rooms_wg" | "rooms_ka" | "finds" | "jobs_ba" | "jobs_arbeitnow" | "casual_ba" | "casual_ka" | "events_culture" | "events_career";

const NAME: Record<Source, string> = {
  rooms_wg: "WG-Gesucht (rooms)", rooms_ka: "Kleinanzeigen (rooms)", finds: "Kleinanzeigen (finds)",
  jobs_ba: "Jobbörse (jobs)", jobs_arbeitnow: "Arbeitnow (jobs)", casual_ba: "Jobbörse (casual jobs)",
  casual_ka: "Kleinanzeigen (casual jobs)", events_culture: "Cultural events", events_career: "Career events",
};
const STALE_HOURS = 12;
// empty pages in a row that mean something's wrong; 0: empty is normal there
// (a niche keyword search on the Jobbörse often finds nothing)
const EMPTY_LIMIT: Record<Source, number> = {
  rooms_wg: 12, rooms_ka: 8, finds: 8, jobs_ba: 0, jobs_arbeitnow: 3, casual_ba: 12, casual_ka: 6, events_culture: 4, events_career: 0,
};
const CHECK_EVERY = 3600;

interface Health { ok: number; empty: number; err?: string; errAt?: number }
const now = () => Math.floor(Date.now() / 1000);
const key = (s: Source) => `health:${s}`;
const read = async (store: Store, s: Source): Promise<Health | null> => {
  const raw = await store.kvGet(key(s));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
};

/** A search worked and read `found` results. */
export async function noteOk(store: Store, s: Source, found: number): Promise<void> {
  const h = await read(store, s);
  await store.kvSet(key(s), JSON.stringify({ ok: now(), empty: found > 0 ? 0 : (h?.empty ?? 0) + 1 }));
}

/** A search failed (not a site's bot check - those have their own handling). */
export async function noteError(store: Store, s: Source, err: unknown): Promise<void> {
  const h = await read(store, s);
  await store.kvSet(key(s), JSON.stringify({ ok: h?.ok ?? now(), empty: h?.empty ?? 0,
    err: String((err as any)?.message ?? err).slice(0, 160), errAt: now() }));
}

/** The sources this config uses, and whether each is switched off or backing off right now. */
async function watched(cfg: Config, store: Store): Promise<{ s: Source; skip: boolean }[]> {
  const t = now();
  const kaBlocked = (await blockSecondsLeft(store, "ka")) > 0;
  const out: { s: Source; skip: boolean }[] = [];
  if (cfg.modules.rooms) {
    const [paused] = await pauseState(store);
    const urls = (cfg.rooms.searches ?? []).map((x) => x.url);
    if (urls.some((u) => !u.includes("kleinanzeigen"))) out.push({ s: "rooms_wg", skip: paused || (await blockSecondsLeft(store, "wg")) > 0 });
    if (urls.some((u) => u.includes("kleinanzeigen"))) out.push({ s: "rooms_ka", skip: paused || kaBlocked });
  }
  if (cfg.modules.finds) {
    const allOff = Object.values(cfg.finds.items).every((i) => !i.on);
    out.push({ s: "finds", skip: allOff || kaBlocked || Number((await store.kvGet("bikes_blocked_until")) ?? 0) > t });
  }
  if (cfg.modules.jobs) {
    const off = (await store.kvGet("jobs_on")) === "0";
    out.push({ s: "jobs_ba", skip: off });
    if (cfg.jobs.arbeitnow) out.push({ s: "jobs_arbeitnow", skip: off });
  }
  if (cfg.modules.casual_jobs) {
    const off = (await store.kvGet("casual_on")) === "0";
    const src = cfg.casual_jobs.sources;
    if (src.includes("minijobs") || src.includes("part_time")) out.push({ s: "casual_ba", skip: off });
    if (src.includes("kleinanzeigen")) out.push({ s: "casual_ka", skip: off });
  }
  if (cfg.modules.events) {
    // its sources are each read every 6-12 hours, so a day without any is the sign
    if (cfg.events.culture) out.push({ s: "events_culture", skip: (await store.kvGet("events_culture_on")) === "0" });
    if (cfg.events.career) out.push({ s: "events_career", skip: (await store.kvGet("events_career_on")) === "0" });
  }
  return out;
}

/** What's wrong with one source right now, or null. */
function problemOf(s: Source, h: Health): string | null {
  const hours = Math.floor((now() - h.ok) / 3600);
  if (hours >= (s.startsWith("events_") ? 30 : STALE_HOURS))
    return `hasn't worked for ${hours} hours` + (h.err && (h.errAt ?? 0) > h.ok ? ` (last error: ${h.err})` : "");
  if (EMPTY_LIMIT[s] && h.empty >= EMPTY_LIMIT[s])
    return `keeps reading empty pages (${h.empty} in a row) - the site may have changed its layout, so nothing new is found`;
  return null;
}

/** The problems now, for /status and /health. */
export async function problems(cfg: Config, store: Store): Promise<string[]> {
  const out: string[] = [];
  for (const { s, skip } of await watched(cfg, store)) {
    if (skip) continue;
    const h = await read(store, s);
    const p = h && problemOf(s, h);
    if (p) out.push(`${NAME[s]} ${p}`);
  }
  return out;
}

/**
 * The hourly check. kv alert:<source>: "suspect" after one bad check,
 * "sent" once the group was told; cleared (with one "works again") when fine.
 */
export async function watchdog(cfg: Config, store: Store, tg: Telegram): Promise<string> {
  const t = now();
  if (t - Number((await store.kvGet("watch_at")) ?? 0) < CHECK_EVERY) return "";
  await store.kvSet("watch_at", String(t));
  const said: string[] = [];
  for (const { s, skip } of await watched(cfg, store)) {
    const h = await read(store, s);
    // a source never seen yet starts its clock now
    if (!h) { await store.kvSet(key(s), JSON.stringify({ ok: t, empty: 0 })); continue; }
    const state = await store.kvGet(`alert:${s}`);
    const p = skip ? null : problemOf(s, h);
    if (p) {
      if (!state) await store.kvSet(`alert:${s}`, "suspect");
      else if (state === "suspect") {
        await tg.send(`⚠️ <b>${esc(NAME[s])} ${esc(p)}</b>\n\nThe bot keeps trying by itself. You'll hear once more when it works again.`);
        await store.kvSet(`alert:${s}`, "sent");
        said.push(`alert ${s}`);
      }
    } else if (state && !skip) {
      if (state === "sent") { await tg.send(`✅ <b>${esc(NAME[s])} works again.</b>`); said.push(`back ${s}`); }
      await store.kvSet(`alert:${s}`, "");
    }
  }
  return said.join(", ");
}
