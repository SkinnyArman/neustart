// One setup, described twice: the way the bot was set up before it read a
// config (a room profile, the job seekers, TOPIC_* vars, and everything else
// written into the code), and as a neustart config. test/golden.mjs runs both
// and expects the same bot.

export const PROFILE = {
  about: {
    name: "Max", age: 25, pronouns: "he/him", whatsapp: "+49 151 0000000",
    always: ["his name is Max, he is 25", "non-smoker, no pets", "will be a student at BTU",
      "fluent in English; German B2", "rent is covered by a blocked account",
      "quiet on weeknights, happy to sit in the kitchen and talk", "respects house rules", "arriving around 1 November"],
    if_relevant: [{ fact: "loves cats", when: "the ad mentions a cat" }],
    contextual: [{ fact: "plays board games", when: "the ad mentions games" }],
    never: ["Never use emojis.", "Never invent facts."],
    move_in_rule: "Arrives around 1 November. Use the ad's date if later.",
  },
  style: { length: "90-120 words", tone: "Friendly and relaxed.", always_include: ["offer a video call"], never_include: ["emojis"], sign_off: "Max" },
  behaviour: { hot_minutes: 15, poll_minutes: 180, max_per_hour: 2, block_backoff_min: 45 },
  searches: [
    { name: "Cottbus", url: "https://www.wg-gesucht.de/wg-zimmer-in-Cottbus.22.0.1.0.html", hot: true },
    { name: "Kleinanzeigen Cottbus", url: "https://www.kleinanzeigen.de/s-auf-zeit-wg/cottbus/anzeige:angebote/c199l7743", hot: true },
    { name: "Forst", url: "https://www.wg-gesucht.de/wg-zimmer-in-Forst.6227.0.1.0.html" },
  ],
  filters: { skip_female_only: true, max_rent: 600, min_rent: 0, skip_if_title_contains: ["nur frauen", "urbanelite"], require_title_contains: [] },
};

const DIBA = { name: "Diba Test", summary: "Data scientist, MDS student", skills: ["Python", "SQL", "Power BI"],
  cv: "Diba CV: two data jobs, SQL -50% reporting time." };
const ARMAN = { name: "Arman Test", summary: "Frontend developer", skills: ["React", "React Native"],
  cv: "Arman CV: React Native app." };

/** Before: kv jobs_people */
export const PEOPLE = { diba: DIBA, arman: ARMAN };

/** Before: wrangler.toml [vars] */
export const TOPICS_ENV = { TOPIC_WG: "597", TOPIC_BIKE: "595", TOPIC_KOMMODE: "596", TOPIC_BED: "598",
  TOPIC_CARPET: "838", TOPIC_FREE: "610", TOPIC_JOBS: "965", TOPIC_CASUAL: "992" };

/** After: kv config, as neustart.yaml describes it */
export const CONFIG = {
  city: "Cottbus",
  kleinanzeigen: "https://www.kleinanzeigen.de/s-cottbus/l7743",
  modules: { rooms: true, finds: true, jobs: true, casual_jobs: true },
  topics: { rooms: 597, bike: 595, kommode: 596, bed: 598, carpet: 838, free: 610, jobs: 965, casual_jobs: 992 },
  rooms: PROFILE,
  finds: {
    radius_km: 30,
    for_whom: "an international student who just arrived in Germany and is setting up a room in a shared flat (WG)",
    items: {
      bike: { max_price: 30 },
      bed: { max_price: 100, width_cm: 140 },
      kommode: { max_price: 35 },
      carpet: { max_price: 30, room_m2: 25 },
      free: { min_rating: 6 },
    },
  },
  jobs: {
    student_permit: true,
    situation: "Both are non-EU master's students in Cottbus on a student residence permit: they may work up to 20 hours a week during the semester (Werkstudent jobs and internships fit); a full-time job does not fit that permit.",
    availability: "master's student in Cottbus, as a Werkstudent up to 20 hours a week during the semester",
    cities: [{ name: "Berlin", radius_km: 25 }, { name: "Cottbus", radius_km: 50 }],
    remote: true,
    people: [
      {
        id: "diba", name: "Diba", icon: "👩‍💻", field: "data", full_name: DIBA.name,
        wants: "Data Scientist (not senior), Data Analyst, Data Engineer, BI/analytics roles - Werkstudent roles first, then internships and junior roles.",
        searches: ["Werkstudent Data", "Werkstudent Data Analyst", "Werkstudent Data Science", "Werkstudent Business Intelligence",
          "Data Analyst", "Data Scientist", "Data Engineer", "Business Analyst"],
        title_words: ["data", "daten", "analyst", "analytics", "analytik", "scien", "statisti", "machine learning", "\\bml\\b",
          "\\bki\\b", "\\bai\\b", "business intelligence", "\\bbi\\b", "reporting", "python", "sql"],
        summary: DIBA.summary, skills: DIBA.skills, cv: DIBA.cv,
      },
      {
        // before: the code searched for Diba alone unless told otherwise
        id: "arman", name: "Arman", icon: "🧑‍💻", field: "frontend", full_name: ARMAN.name, active: false,
        wants: "frontend / web / React / React Native / mobile developer roles - Werkstudent first, then junior or mid-level.",
        searches: ["Werkstudent Frontend", "Werkstudent Softwareentwicklung", "Werkstudent Webentwicklung", "Frontend", "React", "React Native"],
        title_words: ["frontend", "front-end", "react", "javascript", "typescript", "web ?entwick", "web ?develop", "software",
          "developer", "entwickler", "engineer", "programm", "backend", "fullstack", "full-stack", "mobile", "\\bapp\\b", "ios", "android"],
        summary: ARMAN.summary, skills: ARMAN.skills, cv: ARMAN.cv,
      },
    ],
  },
  casual_jobs: { radius_km: 25 },
};
