// What `npm run config` and `npm run setup` share: reading neustart.yaml,
// checking it the way the Worker will, and talking to wrangler.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

export const CF = resolve(dirname(new URL(import.meta.url).pathname), "..");
export const ROOT = resolve(CF, "..");
export const CONFIG_FILE = resolve(ROOT, "neustart.yaml");

/** neustart.yaml as the Worker stores it: a `cv_file` is read and put in as `cv`. */
export function readConfigFile(path = CONFIG_FILE) {
  const raw = parse(readFileSync(path, "utf8")) ?? {};
  for (const p of raw.jobs?.people ?? []) {
    if (p && p.cv_file && !p.cv) {
      p.cv = readFileSync(resolve(dirname(path), p.cv_file), "utf8").trim();
      delete p.cv_file;
    }
  }
  return raw;
}

/** The config the way the Worker will read it: defaults filled in, problems listed. */
export async function check(raw) {
  const { normalize } = await import(resolve(CF, "src/config.ts"));
  return normalize(raw);
}

/** A readable summary of a checked config. */
export function summary(c) {
  const on = Object.entries(c.modules).filter(([, v]) => v).map(([k]) => k);
  const L = [
    `City:      ${c.city || "(none)"}`,
    `Modules:   ${on.join(", ") || "none"}`,
  ];
  if (c.modules.finds) L.push(`Finds:     Kleinanzeigen ${c.ka.slug}/l${c.ka.id}, ${c.finds.radius_km} km`);
  if (c.modules.jobs) {
    L.push(`Jobs:      ${c.jobs.people.map((p) => `${p.name}${p.active ? "" : " (paused)"} - ${p.searches.length} searches`).join("; ")}`);
    L.push(`           in ${c.jobs.cities.map((x) => `${x.name} (${x.radius_km} km)`).join(", ")}${c.jobs.remote ? ", remote" : ""}` +
      (c.jobs.student_permit ? "; student permit: no full-time jobs" : ""));
  }
  if (c.modules.casual_jobs) L.push(`Minijobs:  ${c.casual_jobs.only_city ? `${c.city} itself` : `${c.city}, ${c.casual_jobs.radius_km} km`}`);
  if (c.modules.rooms) L.push(`Rooms:     ${c.rooms.searches.length} searches for ${c.rooms.about.name}`);
  const fixed = Object.entries(c.topics).map(([k, v]) => `${k} ${v}`).join(", ");
  L.push(`Topics:    ${c.topics_mode === "none" ? "none, everything in the main chat" : fixed ? `${fixed}; the rest created when needed` : "created when needed"}`);
  return L.join("\n");
}

/**
 * Kleinanzeigen's code for a city, from its own place suggestions:
 * "Leipzig" -> "leipzig/l4233". Throws when there's no match, or more than
 * one town of that name (then the config has to say which).
 */
export async function lookupKa(city) {
  const r = await fetch(`https://www.kleinanzeigen.de/s-ort-empfehlungen.json?query=${encodeURIComponent(city)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Kleinanzeigen answered ${r.status}`);
  const towns = Object.entries(await r.json())
    .filter(([id, name]) => /^_\d+$/.test(id) && id !== "_0" && name.toLowerCase().startsWith(`${city.toLowerCase()} - `));
  if (towns.length !== 1)
    throw new Error(towns.length ? `more than one ${city}: ${towns.map(([, n]) => n).join("; ")}` : `no town called ${city}`);
  const { slugify } = await import(resolve(CF, "src/config.ts"));
  return `${slugify(city)}/l${towns[0][0].slice(1)}`;
}

/** One kv row as SQL, for wrangler d1 execute --file. */
export const kvSql = (k, v) =>
  `INSERT INTO kv (k,v) VALUES ('${k}','${String(v).replaceAll("'", "''")}') ON CONFLICT(k) DO UPDATE SET v=excluded.v;\n`;

// ---------------------------------------------------------------- wrangler.toml
const TOML = resolve(CF, "wrangler.toml");
export const readToml = () => readFileSync(TOML, "utf8");
export const tomlValue = (toml, key) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(toml)?.[1] ?? "";
export function setTomlValue(toml, key, value) {
  const rx = new RegExp(`^(${key}\\s*=\\s*)"[^"]*"`, "m");
  if (!rx.test(toml)) throw new Error(`wrangler.toml has no ${key}`);
  return toml.replace(rx, `$1"${value}"`);
}
export const writeToml = (toml) => writeFileSync(TOML, toml);
export const dbName = () => tomlValue(readToml(), "database_name");

// ---------------------------------------------------------------- running things
/**
 * npx wrangler <args>, in cf/. With dry: only printed. `input` goes to stdin;
 * `inherit` hands the terminal over (for wrangler login).
 */
export function wrangler(args, { dry = false, input, inherit = false, quiet = false } = {}) {
  if (dry || !quiet) console.log(`  $ npx wrangler ${args.join(" ")}`);
  if (dry) return { ok: true, out: "" };
  const r = spawnSync("npx", ["wrangler", ...args], {
    cwd: CF, input, encoding: "utf8", stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** KEY=value lines from the repo's .env (gitignored). */
export function readEnv(path = resolve(ROOT, ".env")) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
