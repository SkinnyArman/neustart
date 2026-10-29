// npm run config - check neustart.yaml and store it in D1, where the bot
// reads it on its next tick. Nothing to deploy for a config change.
//
//   npm run config                 check, then store it
//   npm run config -- --check      only check it
//   npm run config -- --local      store it in the local database (wrangler dev)
//   --offline                      don't look up the Kleinanzeigen code
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CF, CONFIG_FILE, check, dbName, kvSql, lookupKa, readConfigFile, summary, wrangler } from "./lib.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) ?? CONFIG_FILE;

let raw;
try {
  raw = readConfigFile(file);
} catch (e) {
  console.error(`Couldn't read ${file}: ${e.message}`);
  if (e.code === "ENOENT") console.error("Copy neustart.example.yaml to neustart.yaml and fill it in.");
  process.exit(1);
}
// no Kleinanzeigen code given: look it up from the city's name
if (!raw.kleinanzeigen && raw.city && raw.modules?.finds !== false && !args.includes("--offline")) {
  try {
    raw.kleinanzeigen = await lookupKa(String(raw.city));
    console.log(`Kleinanzeigen: ${raw.city} is ${raw.kleinanzeigen} (add "kleinanzeigen: ${raw.kleinanzeigen}" to skip the lookup)\n`);
  } catch (e) {
    console.error(`Couldn't look up ${raw.city} on Kleinanzeigen (${e.message}) - set kleinanzeigen: in ${file}.\n`);
  }
}
const c = await check(raw);
console.log(summary(c));
if (c.problems.length) {
  console.error(`\nFix these in ${file} first:\n${c.problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
if (args.includes("--check")) process.exit(0);

const sql = resolve(CF, "config.sql");          // gitignored: it holds the CVs
writeFileSync(sql, kvSql("config", JSON.stringify(raw)));
const r = wrangler(["d1", "execute", dbName(), args.includes("--local") ? "--local" : "--remote", "--file=config.sql", "--yes"], { quiet: true });
if (!r.ok) { console.error(r.out.slice(-1500)); process.exit(1); }
console.log(`\nStored. The bot uses it from its next tick.`);
