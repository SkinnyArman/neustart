// Where each kind of post goes. In a group with forum topics, each module
// (and each kind of find) gets its own topic: the ones named in the config's
// `topics:` are used as they are, the rest are created the first time
// something is posted there, if the bot may manage topics. Without that right,
// or in a group without topics, posts go to the main chat, and creating it is
// tried again every few hours.

import type { Config, TopicKey } from "./config.ts";
import type { Store } from "./store.ts";
import type { Telegram } from "./telegram.ts";

export const TOPIC_NAMES: Record<TopicKey, string> = {
  rooms: "🏠 Rooms", bike: "🚲 Bikes", bed: "🛏 Bed", kommode: "🗄 Kommode", carpet: "🧶 Carpet",
  free: "🎁 Free stuff", jobs: "💼 Jobs", casual_jobs: "🧺 Casual jobs",
};
const RETRY_AFTER = 6 * 3600;

/** The topic's thread id, or null for the main chat. */
export async function topicOf(cfg: Config, store: Store, tg: Telegram, key: TopicKey): Promise<number | null> {
  if (cfg.topics[key]) return cfg.topics[key]!;
  if (cfg.topics_mode === "none") return null;
  // "<id>" once created; "0@<time>" when it couldn't be, to try again later
  const saved = await store.kvGet(`topic:${key}`);
  const now = Math.floor(Date.now() / 1000);
  if (saved && !saved.startsWith("0@")) return Number(saved) || null;
  if (saved && now - Number(saved.slice(2)) < RETRY_AFTER) return null;
  try {
    const r = await tg.createForumTopic(TOPIC_NAMES[key]);
    const id = Number(r?.result?.message_thread_id);
    if (id > 0) { await store.kvSet(`topic:${key}`, String(id)); return id; }
  } catch (e: any) {
    console.error(`no topic for ${key} (posting to the main chat):`, e?.message ?? e);
  }
  await store.kvSet(`topic:${key}`, `0@${now}`);
  return null;
}
