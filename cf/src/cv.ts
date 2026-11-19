// 📄 A CV for one job: the person's base CV (kv cv_content:<id>, stored by
// `npm run cv`) reworded in the ad's terms and reordered for it, as a PDF.
//
//   1. the gaps: what the ad asks for that the CV doesn't show (cheap model);
//      each new one is asked once - never used · basics · used it - and the
//      answer kept for every later job (kv cv_skills:<id>)
//   2. two ways to write it:
//        📄 as is - the real CV for this job, plus what they know from the gaps
//        🚀 with the ad's skills - the same, plus every gap in the skills list
//   3. the AI's version is checked here, not trusted: jobs, schooling, dates,
//      places and every number stay the base CV's; skills it adds must be
//      ones it was given; a gap never goes into the experience or profile -
//      only into the skills list.
import type { CvBase, CvVersion } from "./cvpdf.ts";

export type Level = "no" | "basic" | "used";
export interface Known { name: string; level: Level }
/** A person's answers about skills, by key (see skillKey). */
export type KnownSkills = Record<string, Known>;
export const skillKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}+#]/gu, "");

/** The version for the ad's language, or the first there is. */
export function pickVersion(base: CvBase, lang: string): [string, CvVersion] | null {
  const keys = Object.keys(base.versions ?? {});
  if (!keys.length) return null;
  const k = keys.includes(lang) ? lang : keys[0];
  return [k, base.versions[k]];
}

/** All the text of a version, for comparing against. */
export function cvText(base: CvBase, v: CvVersion): string {
  return [base.name, v.title, v.profile,
    ...(v.jobs ?? []).flatMap((e) => [e.title, e.org, e.about, ...(e.bullets ?? [])]),
    ...(v.edu ?? []).flatMap((e) => [e.title, e.org, e.about, ...(e.bullets ?? [])]),
    ...(v.skills ?? []).flat(), ...(v.langs ?? []).flat()].filter(Boolean).join("\n").replace(/\*\*/g, "");
}
const flat = (s: string) => skillKey(s);
/** Is this skill already on the CV, under this name? */
export const onCv = (skill: string, text: string) => {
  const k = flat(skill);
  return k.length > 0 && flat(text).includes(k);
};

// ---------------------------------------------------------------- 1. the gaps
export const GAP_SYSTEM = `You compare a job ad with a CV and list the concrete skills the ad asks for (required or nice to have) that the CV doesn't show.
Only tools, technologies, programming languages, platforms and methods - by the ad's own name for them, short (e.g. "Docker", "dbt", "Looker", "Time series forecasting").
Leave out: soft skills, spoken languages, degrees, years of experience, and anything the CV already shows under another name (the CV has PostgreSQL and the ad says SQL: not a gap).
At most 8, the most important first. Answer as JSON: {"gaps": ["…"]}`;
export const gapUser = (cv: string, ad: string) => `=== CV ===\n${cv.slice(0, 5000)}\n\n=== JOB AD ===\n${ad.slice(0, 6000)}`;

/** The gaps from the AI's answer: real ones only, not on the CV, no repeats. */
export function parseGaps(raw: string, text: string): string[] {
  let d: any;
  try { d = JSON.parse(raw); } catch { return []; }
  const seen = new Set<string>();
  return (Array.isArray(d?.gaps) ? d.gaps : []).map((g: unknown) => String(g).trim().slice(0, 40))
    .filter((g: string) => g && !onCv(g, text) && !seen.has(skillKey(g)) && seen.add(skillKey(g)))
    .slice(0, 8);
}

// ---------------------------------------------------------------- 2. the tailoring
export type Mode = "as-is" | "skills";
const LANG: Record<string, string> = { de: "German", en: "English" };
const BASICS: Record<string, string> = { de: "Grundkenntnisse", en: "basic" };

/** The skills to put in: what they know, and in 🚀 every other gap too. */
export function additions(gaps: string[], known: KnownSkills, mode: Mode, lang: string): string[] {
  const out: string[] = [];
  for (const g of gaps) {
    const k = known[skillKey(g)]?.level;
    if (k === "used") out.push(g);
    else if (k === "basic") out.push(`${g} (${BASICS[lang] ?? "basic"})`);
    else if (mode === "skills") out.push(g);
  }
  return out;
}

export const tailorSystem = (lang: string) => `You tailor a CV to one job ad. You get the CV as JSON and the ad, and return the same JSON with only these changes:
- "profile": rewritten for this role, 2-4 sentences, the same facts, in the ad's words where they truly describe the same thing.
- the "bullets" of each entry in "jobs" and "edu": the same number of bullets, the most relevant to the ad first, each reworded to use the ad's terms where it describes the same work. Every number, result, tool and claim stays exactly as true as it is: nothing added, nothing made bigger. Keep **bold** around the results that have it. Not longer than they are now.
- "skills": the same lines with the same labels; within a line, what the ad asks for first. Add the items you're given under "ADD" (each once, in the line it fits best) and nothing else that isn't already there.
- everything else - "title", "h", job titles, companies, dates, places, "about", "langs" - exactly as it is.
Write in ${LANG[lang] ?? lang}. Answer with the JSON only.`;
export const tailorUser = (v: CvVersion, ad: string, add: string[]) =>
  `=== CV (JSON) ===\n${JSON.stringify(v)}\n\n=== ADD to the skills ===\n${add.length ? add.join("\n") : "(nothing)"}\n\n=== JOB AD ===\n${ad.slice(0, 6000)}`;

// ---------------------------------------------------------------- 3. the checks
const NUM = /\d+(?:[.,․]\d+)*/g;
const numsOf = (s: string) => (s.replace(/ /g, " ").match(NUM) ?? []).map((n) => n.replace(/[,․]/g, "."));
/** A text the AI wrote is fine if its numbers are all the base CV's and it names none of the forbidden skills. */
function honest(text: unknown, baseText: string, forbidden: string[]): text is string {
  if (typeof text !== "string" || !text.trim()) return false;
  const have = new Set(numsOf(baseText));
  if (numsOf(text).some((n) => !have.has(n))) return false;
  const t = text.toLowerCase();
  return !forbidden.some((f) => new RegExp(`(^|[^\\p{L}\\p{N}])${f.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(t));
}
/** "a, b (c, d), e" - the items of a skills line, not split inside brackets. */
export function items(line: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of line) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface Checked { v: CvVersion; kept: string[] }
/**
 * The AI's version, made safe: everything but the profile, the bullets and
 * the skills is the base CV's; a profile or an entry's bullets that fail the
 * checks fall back to the base's; skills not on the CV and not given to add
 * are dropped, and the ones to add are made sure of.
 */
export function check(base: CvBase, v: CvVersion, raw: string, add: string[], gaps: string[]): Checked {
  let out: any;
  try { out = JSON.parse(raw); } catch { out = {}; }
  const baseText = cvText(base, v);
  // a gap may only ever be in the skills list
  const forbidden = gaps.filter((g) => !onCv(g, baseText));
  const kept: string[] = [];
  const r: CvVersion = JSON.parse(JSON.stringify(v));
  if (honest(out.profile, baseText, forbidden)) r.profile = out.profile; else if (out.profile) kept.push("profile");
  for (const part of ["jobs", "edu"] as const) {
    (r[part] ?? []).forEach((e, i) => {
      const b = out[part]?.[i]?.bullets;
      const ok = Array.isArray(b) && b.length === (e.bullets ?? []).length && b.every((x: unknown) => honest(x, baseText, forbidden));
      if (ok) e.bullets = b; else if (b) kept.push(`${part} ${i + 1}`);
    });
  }
  // skills: the base's lines and labels; items the base has, or that were given to add
  const allowed = new Set([...items((v.skills ?? []).map((s) => s[1]).join(", ")).map(skillKey), ...add.map(skillKey)]);
  const inText = (s: string) => onCv(s.replace(/\s*\([^)]*\)\s*$/, ""), baseText);
  const lines = (v.skills ?? []).map(([label, line], i) => {
    const mine = out.skills?.[i];
    const got = Array.isArray(mine) && typeof mine[1] === "string" ? items(mine[1]) : items(line);
    return [label, got.filter((s) => allowed.has(skillKey(s)) || inText(s))] as [string, string[]];
  });
  // nothing of the base's lost, and every addition in
  lines.forEach(([, got], i) => {
    for (const s of items(v.skills![i][1])) if (!got.some((g) => skillKey(g) === skillKey(s))) got.push(s);
  });
  for (const a of add) if (!lines.some(([, got]) => got.some((g) => skillKey(g) === skillKey(a)))) lines[lines.length - 1]?.[1].push(a);
  if (lines.length) r.skills = lines.map(([label, got]) => [label, got.join(", ")]);
  return { v: r, kept };
}

/** Shorter until it fits one page: the last bullet of the entry with the most, never below two. */
export function fit(v: CvVersion, overflows: (v: CvVersion) => boolean): CvVersion {
  const r: CvVersion = JSON.parse(JSON.stringify(v));
  for (let i = 0; i < 10 && overflows(r); i++) {
    const all = [...(r.jobs ?? []), ...(r.edu ?? [])].filter((e) => (e.bullets?.length ?? 0) > 2);
    if (!all.length) break;
    const most = all.reduce((a, b) => ((b.bullets!.length > a.bullets!.length) ? b : a));
    most.bullets!.pop();
  }
  return r;
}
