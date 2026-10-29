# neustart on Cloudflare Workers

The bot, running on Cloudflare's free plan. No card, no VM, no
always-on process to babysit.

Four modules, each on its own cron trigger: rooms (even minutes), finds
(:05, :15, …), jobs (:03, :13, …) and casual jobs (:07, :17, …). Each tick does
**one** small thing, such as refreshing one listing or rating two ads, so no
invocation comes near the free plan's 10 ms CPU limit.

## Setup

    npm install
    npm run setup

`npm run setup` walks through everything, and each step looks at what's
there first, so running it again is safe:

1. checks `../neustart.yaml` (made from `neustart.example.yaml` if it's
   missing) and looks up the city's Kleinanzeigen code if the config
   doesn't give one;
2. reads the keys from `../.env`, asks for any that are missing, finds the
   group's chat id and your user id from a message you send it, and checks
   the OpenAI key and what the bot may do in the group;
3. logs in to Cloudflare;
4. creates the D1 database (on a fresh fork, the Worker and the database
   are called `neustart`) and its tables;
5. deploys, and stores the five secrets: `OPENAI_API_KEY`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_OWNER_ID` (only they
   may run the room search's commands) and `WEBHOOK_SECRET`;
6. stores the config in D1;
7. points Telegram's webhook at the Worker and says hello in the group.

`npm run setup -- --dry-run` shows what it would do without changing anything.

**The config** lives in D1 as kv `config`, not in a Worker secret: with a
room profile and CVs it is far over a secret's 5 KB. After changing
`neustart.yaml`:

    npm run config              # check it, then store it; the bot uses it from its next tick
    npm run config -- --check   # only check it

A module whose part of the config doesn't add up is switched off with a
reason (shown by `npm run config` and in `/status`); the others keep running.

## Day to day

Owner commands: `/status`, `/review`, `/scan`, `/more`, `/filters`,
`/settings`, `/pause`, `/resume`, `/stats`, `/retry`. Open to everyone in
the group: `/finds`, `/jobs`, `/cv`, `/skills`, `/jobreport`.

**Forum topics.** In a group with topics, each kind of post goes to its own
one. The bot creates them the first time it posts there, if it's an admin who
may manage topics (`src/topics.ts`); without that right, posts go to the main
chat and it tries again every 6 hours. Topics you made yourself go in the
config's `topics:` (the number at the end of a topic's link,
`t.me/c/<group>/<topic>`); `topics: none` keeps everything in the main chat.
Commands are answered in the topic they were typed in; a deleted topic's
posts go to the main chat.

**Is it healthy?** `curl 'https://<worker>.workers.dev/health?ai'` answers
`{"ok":true,"openai":"ok"}` when the deployed OpenAI key works. A rejected key
(or no credit) also sends the group one alert - unlike a rate limit, it never
fixes itself. Meanwhile bikes are only posted unrated when their title
clearly names a bike, and rooms that failed can be re-drafted with `/retry`.

**Bot checks are handled quietly.** When wg-gesucht or Kleinanzeigen refuses a
request, that site (and only that site) waits and retries by itself, longer
each time it's refused again: 45, 90, 180 minutes, up to 6 hours. The group
isn't told - `/status` (and `/bikes`) show the countdown. Only an outage that
has gone on for 6 hours straight sends one message, once.

### Finds: bikes, a bed, a Kommode, a carpet, free stuff

An independent job (`src/finds.ts`, `src/findai.ts`) posts cheap or free
finds from Kleinanzeigen within `finds.radius_km` of the city (30 by
default), each with its own price cap:

| | What | Default cap |
|---|---|---|
| 🚲 | adult bikes (Damen, Herren, Weiteres) | 30 € |
| 🛏 | a bed frame for a 140×200 mattress (category Betten; `width_cm` for another) | 100 € |
| 🗄 | a Kommode / chest of drawers (keyword search) | 35 € |
| 🧶 | a normal area rug for a ~25 m² room (keyword Teppich; `room_m2`) | 30 € |
| 🎁 | anything free that's useful for the room (category Zu verschenken; `for_whom` says for whom) | rated 6/10+ |

The config sets the starting caps and which items are on; changes made from
Telegram with `/finds` are kept and win over it.

Each one is read in full and rated 1-10 by a cheap model (`FINDS_MODEL`,
gpt-5.6-luna), with one line on why it got that score and what's worth
knowing before you go and get it.

What gets through is decided mostly without AI:

1. Searches use the seller's own category where there is one (bikes:
   Damen/Herren/Weiteres; beds: Betten), so kids' bikes, accessories and
   mattresses on their own are never fetched.
2. Title rules reject what's obvious - bike parts and "Fahrrad…" compounds,
   kids' markers; beds of another size, bunk/pet beds, slats or mattresses
   alone; changing tables and wardrobe inserts; fitted carpet, runners,
   mats, carpet accessories and rugs of clearly unsuitable sizes.
3. The ad page's own "Art" field has to agree.
4. Ads that were already more than 2 days old when first seen are stored
   quietly: no backlog flood when a search starts, no pinned "TOP" ads.

Only what's left reaches the AI, in the one call it needs anyway for the
rating; that call also confirms it's the right thing (it reads the bed size
from the description, tells a Kommode from a nightstand).

The carpet is for part of the room, not the whole floor: prefer 160×230 or
200×300 cm, accepting rectangular rugs roughly 120–240 cm on the short side
and 160–340 cm on the long side, or round rugs 160–240 cm across. If the ad
never states a size, the AI can still pass it with a note and a score capped
at 5. Without AI, only a clearly named rug with suitable stated rectangular
dimensions can be posted. Carpets get the same ±5 €, pause/resume,
minimum-rating and check-now controls as the other priced finds.

Free stuff comes in fast and is mostly junk, so it has one more tier: titles
that are clearly junk (stones, clothes, plants, sofas, kids' things) are
dropped, titles naming something on the wishlist (kettle, desk, monitor…) go
straight to a full rating, and vague ones ("Verschiedenes zu verschenken") are
screened together in one cheap AI call from their title and preview. Free
beds, Kommoden, carpets and bikes are handed to their own items and topics. Only free
finds rated 6/10 or better are posted; the card's ⭐ buttons move that bar.

It runs on its own cron (every 10 min on odd minutes), so it never shares a
tick or CPU budget with the WG job. Each tick checks the most overdue search
(bikes every 30 min, Weiteres every 2 h, bed, Kommode and carpet hourly) and reads
and rates at most two new ads. It keeps its own
backoff and cookie jar: if Kleinanzeigen rate-limits the bike search, the WG
search is not paused. While the WG search is itself being limited by
Kleinanzeigen, the bike job sits those runs out rather than make it worse.
Only one bike run works at a time (a lock in D1 that expires after 5 min), so
overlapping triggers or a tap on "Check now" can't post a bike twice.

`/finds` is open to **everyone in the group** (all other commands stay
owner-only): a card with − / + price buttons and a pause button per item, a
minimum rating, and check-now. Also `/finds bed 80`, `/finds kommode off`,
`/finds carpet 30`, `/finds carpet off`, `/finds carpet on` (`rug` and `teppich` work too),
`/finds min 5`, `/finds now`; `/bikes` still works for the bikes. It ignores
`/pause`, which only stops the room search.

### Jobs

`src/jobs.ts` posts jobs for the people in the config's `jobs.people` to the
Jobs topic, as cards that double as an application tracker. Sources: the
Bundesagentur's Jobbörse (each person's `searches` around each of
`jobs.cities`, two per tick in rotation) and the Arbeitnow feed (those cities,
or remote; every 2 h). Rules drop senior/lead roles, Ausbildung, and titles
without any of a person's `title_words`; one cheap AI call per remaining job
says who it's for, why, the gaps, German level, hours, start and deadline.
With `student_permit: true`, full-time roles are dropped (a student
residence permit doesn't cover them): by the listed hours when the title
isn't Werkstudent, intern, thesis or part-time, else by the AI.

Who's searching: everyone not marked `active: false`. To switch without
editing the config, set kv `jobs_active` to a list of ids, e.g. `alex` or
`alex,robin`.

Buttons: ✍️ Cover letter (written on tap, from the CV, in the ad's language),
✅ Applied, 🔁 Already applied, ⏭ Skip, then 🗓 Interview / ❌ Rejected / 🎉
Offer. No answer after 10 days: one reminder. `/jobs` is the board and lists
where each application stands, `/skills <id> + Power BI` keeps the skills list
current (changes are kept in D1 and win over the config), `/jobreport` (and every Monday) shows what gets answers, what's due
and the one skill most asked for. Open to everyone in the group.

CVs: send the PDF in the chat and answer it with `/cv <id>`; `/cv` sends it
back, and it comes with every cover letter (Telegram keeps the file, D1 only
its id). To re-post the cards nobody has pressed yet (say, after a layout
change), set kv `jobs_repost` to `1`; `recheck` also runs them through the
rules and the AI again (after a rule change). The next jobs tick does it once.

The "/" menu is sent to Telegram by the jobs tick whenever the command list
in `src/index.ts` changes (or a module is switched on or off): the shared
commands for the group, all of them for the owner.

Profiles and CV text are personal: they're in the gitignored `neustart.yaml`
(or a `cv_file` next to it) and in D1, never in the repo.

### Casual jobs

`src/casual.ts` posts Minijobs within `casual_jobs.radius_km` of the city (25 by default; Aushilfe, Verkauf,
Reinigung, Zeitung austragen, …) to their own topic, from the Jobbörse's
Minijob filter every 30 minutes. No AI and no buttons: each card is the job,
the pay (the hourly wage field, else a euro amount the ad names, else "not
stated"), the times of day, the start and the description. Titles that need
a trade or a licence are left out by a word list. Pause with kv
`casual_on` = `0`.

## Tests

    npm test

Offline tests (Node 22.6+): `finds.test.mjs` (finds, cron dispatch,
commands, permissions), `jobs.test.mjs` (search, rules, matching, cards, the
tracker, /cv, the "/" menu), `casual.test.mjs`, and `config.test.mjs` (the
config, and a bot for another city: other people, other sizes, modules
switched off, topics it creates, `npm run config` and `setup`). They use
synthetic Kleinanzeigen and Jobbörse answers, an in-memory D1 and recorded
OpenAI and Telegram calls. Nothing touches the network.

**The golden run** (`test/golden.mjs`, part of `npm test`) drives the whole
bot through its entry points for simulated hours: every trigger minute by
minute, every command and button, OpenAI rejecting the key, Kleinanzeigen
blocking. It records every request the bot makes and the database it leaves
behind, and compares them with `test/golden.json`, recorded from the code
before the config existed, using the setup in `test/fixtures/config.mjs`. A
change that alters any search URL, prompt, message or stored row shows up
there. When a change is meant to alter them, check the differences it
prints, then `node test/golden.mjs record`.

To run it with your own setup instead of the fixtures, write a module like
`test/fixtures/config.mjs` that exports your `CONFIG` (and the before-config
equivalents), and pass it with `--data <file> --golden <file>`. Keep both
files out of the repo: they hold your profile.

## Local development

    cp .dev.vars.example .dev.vars   # then fill it in
    npx wrangler d1 execute <database> --local --file=schema.sql
    npm run config -- --local
    npx wrangler dev --local --test-scheduled

Fire a scan by hand:

    curl "http://localhost:8787/cdn-cgi/handler/scheduled"

## Costs

Free plan: 100k requests/day, 5 cron triggers, D1 included. This uses 4
triggers, roughly 1,150 cron invocations a day, plus a handful of webhook
calls. The only cost is OpenAI: the finds ratings and job matching on the
cheap model, and the room drafts and cover letters (only on tap) on the
better one.
