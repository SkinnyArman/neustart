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

**Or set it up from Telegram.** Once it's deployed, the owner can skip
`neustart.yaml`: open a private chat with the bot and send `/setup`. It asks
for the city (and finds Kleinanzeigen's code), which modules to use, and
each module's details - mostly buttons - shows a summary, and saves the same
config `npm run config` would, checked the same way. `/setup` never touches
a bot that's already set up: with a config stored it only says so; `/setup
restart` answers everything again (the current config is saved first),
`/setup undo` brings the saved one back, `/setup cancel` drops the answers.
Owner only, private chat only; while a setup is going, the owner's plain
messages in that chat are its answers, and nothing else reads messages
differently.

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
posts go to the main chat. A new topic first gets a short note: what will be
posted there, the budget, and how to change it (once; kv `intro:<topic>`).

**Is it healthy?** `curl 'https://<worker>.workers.dev/health?ai'` makes one
tiny real OpenAI request and answers `{"ok":true,"openai":"ok","problems":[]}`
when it goes through; `problems` lists what the watchdog sees.

**The watchdog** (`src/watch.ts`): every search notes when it worked and how
many results it read. Once an hour a check looks for a source that hasn't
worked for 12 hours, or keeps reading empty pages (what a changed page
layout looks like). A problem has to show at two checks in a row; then the
group hears of it exactly once, and once more when it works again - no
reminders in between. Sites that send their own notice for a long block
(the room search's, the finds') are left to it while they back off. Open
problems also show in `/status`.

**Cards whose ad is gone**: without AI, posted finds, jobs and casual jobs
are looked up again 3 days after they went out, then every 3 days, a few
per tick. A deleted ad marks the card ("Gone from Kleinanzeigen", "No
longer listed"; a job also loses its buttons) and it stops counting as
open in `/status`, `/jobs` and `/finds`. LinkedIn jobs aren't looked up
(Cloudflare can't reach LinkedIn); jobs someone applied to are left alone. A rejected key
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
| 🧼 | a whole, working washing machine (appliance category, keyword; off unless `on: true`) | 50 € |
| 🪑 | a desk chair, comfy enough for studying (keyword Bürostuhl; off unless `on: true`) | 30 € |
| 🎁 | anything free that's useful for the room (category Zu verschenken; `for_whom` says for whom) | rated 6/10+ |

Each item can have its own distance (`radius_km` under the item, or
`/finds chair 4km` in Telegram; `0km` goes back to the finds radius): the
search asks Kleinanzeigen for its next radius step up (5, 10, 20…) and
anything further than the item's limit is dropped.

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
4. Ads that were already more than 3 days old when first seen are stored
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

### Events

`src/events.ts` posts events to two topics (three with sport), without AI: **cultural events**
(theatre, concerts, exhibitions) and **career events** (meetups, hackathons,
the university's career and scholarship notices). Off unless the config's
`modules.events` is on. Readers (`events.sources`): `cottbus_theater`
(Staatstheater Cottbus), `gladhouse` (Glad-House), `cottbus_city`
(cottbus.de), `devpost` (hackathons, online or in Germany), `btu` (BTU's
notices) and `meetup` (the `events.meetup_groups`' calendar feeds).

A third topic, **sport events** (things to join and games to watch), is
there when `events.sport` is on. Readers: `btu_sport` (BTU's university
sport on Buchsys, Cottbus campus: one card per course with places free -
running group, football, yoga, climbing… - with its weekly times and the
student price for the term, also per session, which the budget is checked
against; only kids' courses and the trainers' own are left out), `city_sport` (berlin.de's ticket search,
category Sport, for the city: it covers Berlin and Brandenburg and gives a
price) and `football` (`events.football`: a club's home games from
OpenLigaDB, e.g. `{ team: Energie Cottbus, league: bl2, tickets: <shop> }`;
no price is listed, so the card says so and links the ticket shop). A
kick-off that moves before the card goes out is picked up.

It has its own trigger (:01, :11, …), reads one source per tick, each about
every 6-12 hours, and posts up to four cards a tick. Cultural events over
the budget (`events.max_price`, 10 € by default) wait, in case the budget
goes up before the date (sport events too); ones without a listed price say so. A show on
several dates is posted once; kids' shows, markets and info for school
leavers are left out. Events are posted when they're within
`culture_days` / `career_days` / `sport_days`, never once they're over.

`/events` (anyone in the group): the budget and pausing each topic.

### LinkedIn, from your own computer

LinkedIn refuses requests from Cloudflare (429 on the first one), but
answers a home connection. `scripts/linkedin.mjs` runs on a Mac:

    npm run linkedin             # one run, now (about 10-15 minutes, with a progress bar)

Nothing is scheduled and nothing keeps running: it searches once when you
run it.

Each run searches LinkedIn's public guest pages - no login, no cookies, no
account involved - with each active person's searches (a few terms per
query) in the config's cities, for jobs posted since the last run (at
least a day, at most a week back). After each search the new jobs go
straight to the Worker (`POST /ingest/jobs`, with the `INGEST_SECRET`
header), which matches them on title, company and place and posts them like
any other job, "via LinkedIn" - so a run LinkedIn cuts short still delivers
what it found. At most 10 searches a run, 60-90 s apart, and no job pages;
if LinkedIn says no (429, 999, a login wall) the run stops at once. Run it
from a home connection, not through a VPN: LinkedIn refuses data-centre
addresses.

Needs `NEUSTART_URL` (the Worker's address) and `INGEST_SECRET` in `../.env`,
and the same `INGEST_SECRET` as a Worker secret. Optional in the config:
`jobs.linkedin.searches` (default: the people's own searches).

### Casual jobs

`src/casual.ts` posts casual jobs within `casual_jobs.radius_km` of the city
(25 by default), from the sources in `casual_jobs.sources`: `minijobs` (the
Jobbörse's Minijob filter; the default), `part_time` (its part-time filter,
kept to casual work by title: Verkauf, Reinigung, Service, Lager… - each
card says to check the hours) and `kleinanzeigen` (its Mini- & Nebenjobs
category, hourly, without the job portals' own ads and sales schemes; ads
up to 2 weeks old). Kleinanzeigen waits while it's limiting the room search
or the finds. They go to their own topic. No AI and no buttons: each card is the job,
the pay (the hourly wage field, else a euro amount the ad names, else "not
stated"), the times of day, the start and the description. Titles that need
a trade or a licence are left out by a word list.

With `worth_it: true`, each card starts with a verdict from the cheap model
(✅ Worth it / 🤔 Could be worth it / ❌ Not worth it, and why), weighing
how hard or unpleasant the work is against what it pays. If the AI doesn't
answer, the card goes out without it. kv `casual_repost` = a unix time takes
down the cards posted since then and posts them again on the next tick.

`/casual` (anyone in the group) shows where it looks and changes it: the
radius (`/casual 10`), the town (`/casual city Spremberg`), only the city
itself rather than the towns around it (`/casual only on`, or `only_city:
true` in the config), pause (`/casual off`) and check now. Switching "only
the city" on also takes down the cards already posted from other towns
(kv `casual_recheck` = `1` does the same on the next tick). Changes made
with `/casual` are kept in D1 and win over the config.

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
