// npm run setup - from a fresh fork to a bot that's running, in one go:
// checks neustart.yaml, collects the keys, logs in to Cloudflare, creates the
// database, deploys, stores the secrets and the config, points Telegram at
// the Worker and says hello in the group. Each step looks at what's already
// there first, so running it again is safe.
//
//   npm run setup
//   npm run setup -- --dry-run     show what it would do; change nothing
//   (--config <file>, --env <file>: other files than ../neustart.yaml, ../.env)
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import {
  CF, CONFIG_FILE, ROOT, check, kvSql, lookupKa, readConfigFile, readEnv, readToml, setTomlValue,
  summary, tomlValue, wrangler, writeToml,
} from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const DRY = argv.includes("--dry-run");
const CONFIG = resolve(opt("--config") ?? CONFIG_FILE);
const ENV_FILE = resolve(opt("--env") ?? resolve(ROOT, ".env"));
const step = (n, t) => console.log(`\n${n}. ${t}`);
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (DRY ? "" : (await rl.question(q)).trim());

const tgApi = async (token, method, body = {}) => {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
};

console.log(DRY ? "neustart setup (dry run: nothing is changed)" : "neustart setup");

// ---------------------------------------------------------------- 1. the config
step(1, "Your config");
if (!existsSync(CONFIG)) {
  if (!DRY) copyFileSync(resolve(ROOT, "neustart.example.yaml"), CONFIG);
  console.log(`  Made ${CONFIG} from the example. Fill it in (city, who's searching, the room\n` +
    `  profile), then run npm run setup again.`);
  process.exit(0);
}
const raw = readConfigFile(CONFIG);
if (!raw.kleinanzeigen && raw.city && raw.modules?.finds !== false && !DRY) {
  try { raw.kleinanzeigen = await lookupKa(String(raw.city)); console.log(`  Kleinanzeigen: ${raw.city} is ${raw.kleinanzeigen}`); }
  catch (e) { console.log(`  Couldn't look up ${raw.city} on Kleinanzeigen: ${e.message}`); }
}
const cfg = await check(raw);
console.log(summary(cfg).replace(/^/gm, "  "));
if (cfg.problems.length) fail(`Fix these in ${CONFIG} first:\n${cfg.problems.map((p) => `  - ${p}`).join("\n")}`);

// ---------------------------------------------------------------- 2. the keys
step(2, "Keys (kept in .env, which is gitignored)");
const env = readEnv(ENV_FILE);
const added = {};
const need = async (k, how) => {
  if (env[k]) return console.log(`  ${k}: from .env`);
  const v = await ask(`  ${k} (${how}): `);
  if (!v && !DRY) fail(`${k} is needed.`);
  env[k] = added[k] = v || `<${k}>`;
};
await need("OPENAI_API_KEY", "platform.openai.com → API keys");
await need("TELEGRAM_BOT_TOKEN", "make a bot with @BotFather, paste its token");
if (!DRY) {
  const me = await tgApi(env.TELEGRAM_BOT_TOKEN, "getMe");
  if (!me.ok) fail(`Telegram doesn't accept the bot token (${me.description}).`);
  env.BOT_ID = String(me.result.id);
  console.log(`  Bot: @${me.result.username}`);
  if (!env.TELEGRAM_CHAT_ID || !env.TELEGRAM_OWNER_ID) {
    // the group and its owner, from a message sent to the bot
    await ask(`  Add @${me.result.username} to your group, send any message there, then press Enter… `);
    const up = await tgApi(env.TELEGRAM_BOT_TOKEN, "getUpdates", { allowed_updates: ["message"] });
    const m = [...(up.result ?? [])].reverse().map((u) => u.message).find((x) => x?.chat);
    if (!m) fail("No message reached the bot. In a group, the bot only sees /commands unless it's an admin - send /start there, then run setup again.");
    env.TELEGRAM_CHAT_ID ||= added.TELEGRAM_CHAT_ID = String(m.chat.id);
    env.TELEGRAM_OWNER_ID ||= added.TELEGRAM_OWNER_ID = String(m.from.id);
    console.log(`  Group: ${m.chat.title ?? "private chat"} (${m.chat.id}); owner: ${m.from.first_name} (${m.from.id})`);
  }
} else {
  for (const k of ["TELEGRAM_CHAT_ID", "TELEGRAM_OWNER_ID"]) if (!env[k]) env[k] = `<${k}>`;
}
if (!env.WEBHOOK_SECRET) env.WEBHOOK_SECRET = added.WEBHOOK_SECRET = randomBytes(24).toString("hex");
if (Object.keys(added).length && !DRY)
  appendFileSync(ENV_FILE, "\n" + Object.entries(added).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
if (Object.keys(added).length) console.log(`  Saved to .env: ${Object.keys(added).join(", ")}`);

if (!DRY) {
  const model = tomlValue(readToml(), "FINDS_MODEL") || "gpt-5.6-luna";
  const r = await fetch(`https://api.openai.com/v1/models/${model}`, { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } });
  if (!r.ok) fail(`OpenAI doesn't accept the key for ${model} (${r.status}).`);
  console.log(`  OpenAI: the key works`);
  // what the group lets the bot do
  const chat = await tgApi(env.TELEGRAM_BOT_TOKEN, "getChat", { chat_id: env.TELEGRAM_CHAT_ID });
  if (!chat.ok) fail(`The bot can't see the chat ${env.TELEGRAM_CHAT_ID} (${chat.description}). Is it in the group?`);
  if (chat.result.type !== "private" && cfg.topics_mode === "auto") {
    const mem = await tgApi(env.TELEGRAM_BOT_TOKEN, "getChatMember", { chat_id: env.TELEGRAM_CHAT_ID, user_id: Number(env.BOT_ID) });
    const missing = Object.entries(cfg.topics).length === 8 ? [] : [
      ...(chat.result.is_forum ? [] : ["turn on Topics in the group's settings"]),
      ...(mem.result?.status === "administrator" && mem.result.can_manage_topics ? [] : ["make the bot an admin who may manage topics"]),
    ];
    console.log(missing.length
      ? `  Topics: to give each module its own topic, ${missing.join(" and ")}. Until then everything goes to the main chat.`
      : `  Topics: the bot creates them as it needs them`);
  }
}

// ---------------------------------------------------------------- 3. Cloudflare
step(3, "Cloudflare");
const who = wrangler(["whoami"], { dry: DRY, quiet: true });
if (!DRY && !/logged in/i.test(who.out)) {
  console.log("  Not logged in - opening the browser…");
  if (!wrangler(["login"], { inherit: true }).ok) fail("Cloudflare login didn't work.");
}

// ---------------------------------------------------------------- 4. the database
step(4, "Database");
let toml = readToml();
let db = tomlValue(toml, "database_name");
const list = DRY ? { ok: true, out: "[]" } : wrangler(["d1", "list", "--json"], { quiet: true });
let dbs = [];
try { dbs = JSON.parse(list.out.slice(list.out.indexOf("["))); } catch { /* none */ }
const mine = dbs.find((d) => d.name === db);
if (mine) {
  console.log(`  ${db} is there (${mine.uuid})`);
  if (tomlValue(toml, "database_id") !== mine.uuid) toml = setTomlValue(toml, "database_id", mine.uuid);
} else {
  // a fresh fork: the database (and the Worker) are called neustart
  if (db === "wg-finder") { db = "neustart"; toml = setTomlValue(setTomlValue(toml, "database_name", db), "name", "neustart"); }
  const made = wrangler(["d1", "create", db], { dry: DRY });
  const id = /database_id\s*=\s*"([^"]+)"/.exec(made.out)?.[1] ?? /"database_id":\s*"([^"]+)"/.exec(made.out)?.[1];
  if (!DRY && !id) fail(`Couldn't create the database:\n${made.out.slice(-800)}`);
  toml = setTomlValue(toml, "database_id", id ?? "<new id>");
  console.log(`  Created ${db}`);
}
if (!DRY) writeToml(toml);
if (!wrangler(["d1", "execute", db, "--remote", "--file=schema.sql", "--yes"], { dry: DRY, quiet: true }).ok) fail("Couldn't create the tables.");
console.log("  Tables ready");

// ---------------------------------------------------------------- 5. deploy and secrets
step(5, "Deploy");
const dep = wrangler(["deploy"], { dry: DRY, quiet: true });
if (!dep.ok) fail(`Deploy failed:\n${dep.out.slice(-1500)}`);
const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(dep.out)?.[0] ?? (DRY ? "https://<worker>.workers.dev" : "");
if (!url) fail(`Deployed, but no workers.dev address in the output:\n${dep.out.slice(-800)}`);
console.log(`  Running at ${url}`);

// in a file of its own, only for as long as wrangler needs it
const dir = mkdtempSync(join(tmpdir(), "neustart-"));
const secrets = join(dir, "secrets.json");
if (!DRY) writeFileSync(secrets, JSON.stringify(Object.fromEntries(
  ["OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_OWNER_ID", "WEBHOOK_SECRET"].map((k) => [k, env[k]]))), { mode: 0o600 });
const sec = wrangler(["secret", "bulk", secrets], { dry: DRY, quiet: true });
rmSync(dir, { recursive: true, force: true });
if (!sec.ok) fail(`Couldn't store the secrets:\n${sec.out.slice(-800)}`);
console.log("  Secrets stored");

// ---------------------------------------------------------------- 6. the config
step(6, "Config");
if (!DRY) writeFileSync(resolve(CF, "config.sql"), kvSql("config", JSON.stringify(raw)));
if (!wrangler(["d1", "execute", db, "--remote", "--file=config.sql", "--yes"], { dry: DRY, quiet: true }).ok) fail("Couldn't store the config.");
console.log("  Stored");

// ---------------------------------------------------------------- 7. Telegram
step(7, "Telegram");
if (!DRY) {
  const hook = await tgApi(env.TELEGRAM_BOT_TOKEN, "setWebhook",
    { url, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
  if (!hook.ok) fail(`Telegram didn't take the webhook: ${hook.description}`);
  await tgApi(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID,
    text: `👋 neustart is set up for ${cfg.city}. The first posts come within the next half hour. Type / to see the commands.` });
}
console.log(`  Webhook set; said hello in the group`);
console.log(`\nDone. Later changes to neustart.yaml: npm run config. To see it working: npx wrangler tail`);
rl.close();
