// Cover letters: a complete Anschreiben (or English letter) for one job, a
// short "Why us?" for the application form, and a PDF to upload.
//
// Cost: one call to the letter model writes it all (the person's CV comes
// first and stays the same between letters, so OpenAI's prompt cache keeps
// repeat letters cheap). A check in code then looks for skills from the ad
// the CV doesn't have, numbers from nowhere and stock phrases - only if it
// finds something does the budget model fix it. Shorter / more formal /
// more casual / German / English rework the letter with the budget model,
// and each press nudges that person's default length and tone for the next
// letters. Gaps are never mentioned: only what they can do.

import type { Config, Person } from "./config.ts";
import type { Store } from "./store.ts";

export interface Letter {
  lang: "de" | "en";
  subject: string;
  salutation: string;
  body: string;            // paragraphs, blank lines between
  closing: string;
  why: string;             // 2-3 sentences for a "Why us?" form field
}
export interface Style { words: number; tone: number }   // tone: -2 casual … +2 formal
export const DEFAULT_STYLE: Style = { words: 160, tone: 0 };

// words and phrases that make a letter read as generated or as a template, in either language (from the humanizer checklist)
export const STOCK = ["passionate", "excited", "thrilled", "eager", "dynamic", "innovative", "cutting-edge", "leverage", "delve",
  "foster", "synergy", "seamless", "robust", "tapestry", "pivotal", "underscore", "testament", "enhance", "crucial", "multifaceted",
  "holistic", "unlock", "elevate", "game-changer", "vibrant", "realm", "I am confident", "I am writing to", "furthermore", "moreover",
  "additionally", "in today's", "it's important to note", "it is worth mentioning", "in summary", "in conclusion", "not just",
  "hiermit bewerbe ich mich", "mit großem Interesse", "begeistert", "Begeisterung", "leidenschaftlich", "Leidenschaft", "hochmotiviert",
  "spannende Herausforderung", "spannend", "Teamplayer", "zielorientiert", "Mehrwert", "Ihr renommiertes Unternehmen", "abgerundet",
  "wertvollen Beitrag", "würde ich mich sehr freuen", "darüber hinaus", "des Weiteren", "zusammenfassend", "spielt eine entscheidende Rolle",
  "spielt eine zentrale Rolle", "nicht nur", "vielschichtig", "facettenreich", "maßgeblich"];

const toneWords = (t: number) => t >= 2 ? "formal and polished" : t === 1 ? "polite and slightly formal"
  : t === 0 ? "friendly and professional" : t === -1 ? "warm and a little casual" : "relaxed and casual (still respectful)";

/** The system prompt: the person and the rules first (the same for every letter, so it's cached), the style last. */
export function letterSystem(p: Person): string {
  return `You write job applications for ${p.name} (${p.full_name}). Everything you may say about them is in the CV and profile below - never invent experience, tools, numbers, grades or dates.

=== PROFILE ===
${p.summary}

=== CV ===
${p.cv}

=== RULES ===
Return JSON only: {"lang": "de"|"en", "subject": string, "salutation": string, "body": string, "closing": string, "why": string}
- lang: the ad's language. German: a proper Anschreiben with "Sie".
- subject: "Bewerbung als <the role as the ad names it, without (m/w/d)>" (German) or "Application: <role>" (English); add the reference number if one is given.
- salutation: the contact person if the ad names one ("Sehr geehrte Frau Schmidt," / "Dear Ms Schmidt,"), else "Sehr geehrte Damen und Herren," / "Dear Hiring Team,".
- body: 3 short paragraphs of different lengths, plain text, blank lines between, no greeting and no signature in it.
  1) Start with something specific from this ad (the product, team, project, a task or tool they mention) - it must be clear the ad was read. No generic praise.
  2) Why they fit: what the ad asks for and where the CV shows it. A cover letter is not the CV: no walk through jobs and tools, at most one concrete result with its number.
  3) Availability and the practical side: ${p.availability}. A start date, and remote or on-site only if it matters for this ad.
- Only strengths. Never mention a skill, tool or experience they don't have, and never say what they lack.
- Write like a person, not a template: mix very short sentences with longer ones, vary how sentences start (a sentence may start with "And"/"Und" or "But"/"Aber"), everyday words.
- No dashes as punctuation at all (no em dash, no en dash, no spaced hyphen): use a period, comma, colon or parentheses. No lists, no rhetorical questions, no exaggeration.
- None of these patterns: "not X but Y" / "nicht nur ..., sondern auch", reflexive threes, recaps, a vague significance clause after a fact, puffery, claiming a quality instead of showing it.
- German: after "Sehr geehrte Frau X," the body starts lowercase (unless it starts with Sie/Ihr or a noun). Short closing line: "Über ein Gespräch freue ich mich." rather than a long one.
- Never use these: ${STOCK.join(", ")}.
- closing: "Mit freundlichen Grüßen" (German) or "Kind regards" (English).
- why: 2-3 sentences for a "Why do you want to work with us?" form field, in the ad's language, specific to this company and role.`;
}
export const letterUser = (job: { title: string; company: string; place: string; ref?: string; text: string }, style: Style) =>
  `=== JOB ===\nTitle: ${job.title}\nCompany: ${job.company}\nPlace: ${job.place}${job.ref ? `\nReference: ${job.ref}` : ""}\n\n${job.text.slice(0, 5000)}\n\n` +
  `=== STYLE ===\nAbout ${style.words} words in the body. Tone: ${toneWords(style.tone)}.`;

export type AI = (model: string, system: string, user: string, json: boolean) => Promise<string>;

/** A letter from the model's JSON, tidied: no em dashes, the parts it must have. */
export function parseLetter(raw: string): Letter {
  const d = JSON.parse(raw || "{}");
  const de = d.lang !== "en";
  // no dashes as punctuation: a comma reads fine where a dash was
  const clean = (s: unknown) => String(s ?? "").trim().replace(/\s+[—–-]\s+|\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",");
  const l: Letter = {
    lang: de ? "de" : "en", subject: clean(d.subject), salutation: clean(d.salutation) || (de ? "Sehr geehrte Damen und Herren," : "Dear Hiring Team,"),
    body: clean(d.body).replace(/\n{3,}/g, "\n\n"), closing: clean(d.closing) || (de ? "Mit freundlichen Grüßen" : "Kind regards"), why: clean(d.why),
  };
  if (!l.body) throw new Error("the letter came back empty");
  return l;
}

/**
 * Problems a reader would catch, found without AI: a skill from the ad the
 * CV doesn't have, a number that's in neither, a stock phrase.
 */
export function letterIssues(l: Letter, cv: string, ad: string, adSkills: string[]): string[] {
  const text = `${l.body}\n${l.why}`, low = text.toLowerCase(), have = `${cv}\n${ad}`.toLowerCase();
  const out: string[] = [];
  for (const s of adSkills) {
    const k = s.toLowerCase().trim();
    if (k.length > 1 && new RegExp(`(^|[^\\p{L}])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(low) && !cv.toLowerCase().includes(k))
      out.push(`claims "${s}", which isn't in the CV`);
  }
  for (const n of new Set(text.match(/\b\d+(?:[.,]\d+)?\s?%|\b\d{2,}\b/g) ?? []))
    if (!have.includes(n.replace(/\s/g, "").toLowerCase()) && !have.includes(n.toLowerCase())) out.push(`the number "${n}" isn't in the CV or the ad`);
  for (const s of STOCK) if (low.includes(s.toLowerCase())) out.push(`uses the stock phrase "${s}"`);
  // the strongest tell: every sentence about as long as the next
  const lens = l.body.split(/(?<=[.!?])\s+/).map((x) => x.split(/\s+/).filter(Boolean).length).filter((n) => n > 0);
  if (lens.length >= 5) {
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    if (sd < 4 || !lens.some((n) => n <= 8)) out.push("the sentences are all about the same length: add a few very short ones and let one run longer");
  }
  return out;
}

const ADJUST: Record<string, string> = {
  short: "Make it noticeably shorter (about two thirds of the length), keeping the specific opening and the concrete matches.",
  formal: "Make the tone more formal and polished.",
  casual: "Make the tone warmer and a little more casual - still respectful and professional.",
  de: "Rewrite it in German, as a proper Anschreiben with \"Sie\" (subject, salutation and closing in German too).",
  en: "Rewrite it in English (subject, salutation and closing in English too).",
};
/** Rework with the budget model: shorter, more formal, more casual, the other language - or fix the listed problems. */
export async function adjustLetter(ai: AI, model: string, l: Letter, how: string, cv: string): Promise<Letter> {
  const sys = `You edit a job application letter so it reads like a person wrote it. Keep every fact as it is; never add experience, tools or numbers that aren't in the letter or the CV, never mention what the applicant lacks. Mix very short and longer sentences, no dashes as punctuation, no "not X but Y" / "nicht nur ... sondern auch", no recaps, no stock phrases (${STOCK.join(", ")}). Return the same JSON shape: {"lang", "subject", "salutation", "body", "closing", "why"}.`;
  const user = `=== CV (the only facts allowed) ===\n${cv.slice(0, 4000)}\n\n=== LETTER ===\n${JSON.stringify(l)}\n\n=== DO ===\n${ADJUST[how] ?? how}`;
  return parseLetter(await ai(model, sys, user, true));
}

/** How a press changes the person's default for later letters. */
export function learn(s: Style, how: string): Style {
  if (how === "short") return { ...s, words: Math.max(90, s.words - 20) };
  if (how === "formal") return { ...s, tone: Math.min(2, s.tone + 1) };
  if (how === "casual") return { ...s, tone: Math.max(-2, s.tone - 1) };
  return s;
}
export async function styleOf(store: Store, person: string): Promise<Style> {
  return { ...DEFAULT_STYLE, ...JSON.parse((await store.kvGet(`letter_style:${person}`)) ?? "{}") };
}

/** The whole letter as text, to copy. */
export const letterText = (l: Letter, name: string) => `${l.salutation}\n\n${l.body}\n\n${l.closing}\n${name}`;

/** "Cottbus, 14.11.2026" */
export function placeDate(city: string, t = Date.now()): string {
  const d = new Date(t).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" });
  return `${city}, ${d}`;
}

/** Read the employer's own page for the ad's full text, when what we have is thin. Plain text, scripts and menus left out. */
export async function adText(url: string): Promise<string> {
  if (!/^https?:\/\//.test(url) || /linkedin\.com|workingstudentjobs\.de|arbeitsagentur\.de/.test(url)) return "";
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36" }, redirect: "follow" });
    if (!r.ok || !/html/i.test(r.headers.get("content-type") ?? "")) return "";
    const html = (await r.text()).slice(0, 400_000);
    const t = html.replace(/<(script|style|nav|header|footer|noscript|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|li|h\d|div)>/gi, "\n")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
    return t.length > 300 ? t.slice(0, 6000) : "";
  } catch { return ""; }
}

export type { Config };
