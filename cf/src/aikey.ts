// A rejected OpenAI key never fixes itself - unlike a rate limit - so it is
// the one failure the group hears about straight away. Once per outage: the
// first good answer from OpenAI resets it.

import type { Store } from "./store.ts";
import type { Telegram } from "./telegram.ts";

/** 401/403 (bad or revoked key) or no credit left: needs a human. */
export const keyRejected = (msg: string) =>
  /OpenAI (401|403)\b/.test(msg) || /insufficient_quota/.test(msg);

export async function aiFailed(store: Store, tg: Telegram, err: unknown): Promise<void> {
  const msg = String((err as any)?.message ?? err);
  if (!keyRejected(msg) || (await store.kvGet("ai_key_alerted")) === "1") return;
  await store.kvSet("ai_key_alerted", "1");
  const quota = /insufficient_quota/.test(msg);
  await tg.send(
    `⚠️ <b>OpenAI ${quota ? "has no credit left" : "rejected the API key"}</b>\n\n` +
    `Bike ratings and WG drafts can't run until it's fixed. Bikes are only ` +
    `posted meanwhile if their title clearly names a bike; rooms that fail ` +
    `can be re-drafted with /retry afterwards.\n\n` +
    (quota
      ? `Fix: add credit at platform.openai.com.`
      : `Fix: a new key from platform.openai.com, then in the cf folder ` +
        `<code>npx wrangler secret put OPENAI_API_KEY</code>.`));
}

export async function aiWorked(store: Store): Promise<void> {
  if ((await store.kvGet("ai_key_alerted")) === "1") await store.kvSet("ai_key_alerted", "0");
}

/**
 * For /health?ai: does a real request go through? A tiny one, the same kind
 * the bot makes (looking a model up can be refused while requests work).
 */
export async function checkKey(apiKey: string, model: string): Promise<string> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with OK." }], max_completion_tokens: 16 }),
  });
  if (r.ok) return "ok";
  const why = r.status === 429 ? "rate limited or out of credit" : r.status === 401 || r.status === 403 ? "key rejected" : "error";
  return `${why} (${r.status})`;
}
