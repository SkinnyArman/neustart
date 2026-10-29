# neustart on Cloudflare Workers

The bot, running on Cloudflare's free plan. No card, no VM, no
always-on process to babysit. (The Worker and its D1 database are still
called `wg-finder`, the project's first name; the commands below use it.)

Four jobs, each on its own cron trigger: WG rooms (even minutes), finds
(:05, :15, …), jobs (:03, :13, …) and casual jobs (:07, :17, …). Each tick does
**one** small thing, such as refreshing one listing or rating two ads, so no
invocation comes near the free plan's 10 ms CPU limit.

## Deploy

### 1. Install and log in

    cd cf
    npm install
    npx wrangler login

### 2. Create the database

    npx wrangler d1 create wg-finder

Copy the printed `database_id` into `wrangler.toml`, then create the tables:

    npm run db:init

### 3. Load your profile

`profile.yaml` is ~4.5KB of JSON, which exceeds the 5.1KB limit on Worker
secrets once encoded — so it lives in D1 instead:

    ./make-profile.sh
    npx wrangler d1 execute wg-finder --remote --file=profile.sql

It is cached per isolate, so this costs nothing at runtime.

For the Jobs topic, the job seekers' profiles and CV text go in the
gitignored `jobs-people.json`, loaded with:

    ./seed-jobs.sh

The jobs and casual-jobs tables create themselves on first use.

### 4. Secrets

    npx wrangler secret put OPENAI_API_KEY
    npx wrangler secret put TELEGRAM_BOT_TOKEN
    npx wrangler secret put TELEGRAM_CHAT_ID     # group id (negative) or your own
    npx wrangler secret put TELEGRAM_OWNER_ID    # your user id — only you can command it
    npx wrangler secret put WEBHOOK_SECRET       # any random string you invent

### 5. Deploy

    npm run deploy

Note the URL it prints, e.g. `https://wg-finder.<you>.workers.dev`.

### 6. Point Telegram at it

Telegram pushes updates to you instead of you polling. Register the webhook,
using the same secret you set above:

    curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
      -d "url=https://wg-finder.<you>.workers.dev" \
      -d "secret_token=<WEBHOOK_SECRET>"

Send `/start` in Telegram. If it answers, you're done.

## Day to day

Owner commands: `/status`, `/review`, `/scan`, `/more`, `/filters`,
`/settings`, `/pause`, `/resume`, `/stats`, `/retry`. Open to everyone in
the group: `/finds`, `/jobs`, `/cv`, `/skills`, `/jobreport`.

**Forum topics.** If the group has topics, each kind of post goes to its own
one: set `TOPIC_WG`, `TOPIC_BIKE`, `TOPIC_BED`, `TOPIC_KOMMODE`, `TOPIC_CARPET`,
`TOPIC_FREE`, `TOPIC_JOBS` and `TOPIC_CASUAL` in `wrangler.toml` to the number
at the end of the topic's link (`t.me/c/<group>/<topic>`). Commands are answered in the topic they were
typed in; anything without a topic (or with a deleted one) goes to General.

**Is it healthy?** `curl 'https://wg-finder.<you>.workers.dev/health?ai'` answers
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

A second, independent job (`src/finds.ts`, `src/findai.ts`) posts cheap or
free finds from Kleinanzeigen within 30 km of Cottbus to the same group, each
with its own price cap:

| | What | Default cap |
|---|---|---|
| 🚲 | adult bikes (Damen, Herren, Weiteres) | 30 € |
| 🛏 | a bed frame for a 140×200 mattress (category Betten) | 100 € |
| 🗄 | a Kommode / chest of drawers (keyword search) | 35 € |
| 🧶 | a normal area rug for a ~25 m² room (keyword Teppich) | 30 € |
| 🎁 | anything free a new student can use for their room (category Zu verschenken) | rated 6/10+ |

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
dimensions can be posted. Carpets go to topic `838`, with the same ±5 €,
pause/resume, minimum-rating and check-now controls as the other priced finds.

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

### Jobs (for Diba and Arman)

`src/jobs.ts` posts jobs to the Jobs topic as cards that double as an
application tracker. Sources: the Bundesagentur's Jobbörse (keyword searches
around Berlin and Cottbus, two per tick in rotation) and the Arbeitnow feed
(Berlin, Cottbus, remote; every 2 h). Rules drop senior/lead roles,
Ausbildung and off-topic titles; one cheap AI call per remaining job says who
it's for, why, the gaps, German level, hours, start and deadline. Full-time
roles are dropped (a student permit doesn't cover them): by the listed hours
when the title isn't Werkstudent, intern, thesis or part-time, else by the AI.

Buttons: ✍️ Cover letter (written on tap, from the CV, in the ad's language),
✅ Applied, 🔁 Already applied, ⏭ Skip, then 🗓 Interview / ❌ Rejected / 🎉
Offer. No answer after 10 days: one reminder. `/jobs` is the board and lists
where each application stands, `/skills diba + Power BI` keeps the skills list
current, `/jobreport` (and every Monday) shows what gets answers, what's due
and the one skill most asked for. Open to everyone in the group.

CVs: send the PDF in the chat and answer it with `/cv diba`; `/cv` sends it
back, and it comes with every cover letter (Telegram keeps the file, D1 only
its id). To re-post the cards nobody has pressed yet (say, after a layout
change), set kv `jobs_repost` to `1`; `recheck` also runs them through the
rules and the AI again (after a rule change). The next jobs tick does it once.

The "/" menu is sent to Telegram by the jobs tick whenever the command list
in `src/index.ts` changes: the shared commands for the group, all of them for
the owner.

Profiles and CV text are personal: they live in the gitignored
`jobs-people.json` and are loaded into D1 with `./seed-jobs.sh`.

### Casual jobs (Cottbus)

`src/casual.ts` posts Minijobs within 25 km of Cottbus (Aushilfe, Verkauf,
Reinigung, Zeitung austragen, …) to their own topic, from the Jobbörse's
Minijob filter every 30 minutes. No AI and no buttons: each card is the job,
the pay (the hourly wage field, else a euro amount the ad names, else "not
stated"), the times of day, the start and the description. Titles that need
a trade or a licence are left out by a word list. Pause with kv
`casual_on` = `0`.

## Tests

    npm test

Offline tests (Node 22.6+) in three suites: `finds.test.mjs` (finds, cron
dispatch, commands, permissions), `jobs.test.mjs` (search, rules, matching,
cards, the tracker, /cv, the "/" menu) and `casual.test.mjs`. They use
synthetic Kleinanzeigen and Jobbörse answers, an in-memory D1 and recorded
OpenAI and Telegram calls. Nothing touches the network.

## Local development

    cp .dev.vars.example .dev.vars   # then fill it in
    npx wrangler d1 execute wg-finder --local --file=schema.sql
    npx wrangler d1 execute wg-finder --local --file=profile.sql
    npx wrangler dev --local --test-scheduled

Fire a scan by hand:

    curl "http://localhost:8787/cdn-cgi/handler/scheduled"

## Costs

Free plan: 100k requests/day, 5 cron triggers, D1 included. This uses 4
triggers, roughly 1,150 cron invocations a day, plus a handful of webhook
calls. The only cost is OpenAI: the finds ratings and job matching on the
cheap model, and the room drafts and cover letters (only on tap) on the
better one.
