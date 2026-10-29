# neustart

A Telegram bot for anyone moving to a city in Germany. Tell it the city and
who's moving, and it looks for a WG room, cheap furniture and jobs there,
and posts what it finds to your Telegram group, one forum topic per kind of
thing. It runs for free on Cloudflare Workers; the only cost is OpenAI, a few
euros a month.

Fork it, fill in one config file, run one command.

## What it does

| Topic | What it finds | Where from | AI |
|---|---|---|---|
| 🏠 **Rooms** | New WG room ads. Each card has a "Draft reply" button that writes a reply in the ad's language from your profile. | WG-Gesucht, Kleinanzeigen | Only when you tap Draft |
| 🚲 🛏 🗄 🧶 **Finds** | Cheap bikes, a bed (140×200 or your size), a Kommode and a rug within your radius, each under its own price cap. | Kleinanzeigen | Rates what the rules let through, 1–10 |
| 🎁 **Free stuff** | Giveaways worth picking up for a new room. | Kleinanzeigen, "Zu verschenken" | Screens vague titles, rates the rest |
| 💼 **Jobs** | Jobs for each person in the config, from their own searches, in the cities you list or remote. Each card says who it fits, why, the gaps, the German level, the hours and the deadline. Buttons track each application from Applied to Offer; cover letters on tap. On a student permit: Werkstudent jobs first, no full-time. | Jobbörse (Arbeitsagentur), Arbeitnow | Matching; cover letters on tap |
| 🧺 **Casual jobs** | Minijobs (Aushilfe, Verkauf, Reinigung…) with the pay, the hours and the description. | Jobbörse, Minijob filter | None |

Switch off what you don't need. Nothing is ever sent to a landlord or an
employer: the bot drafts, you send.

Everyone in the group can use `/jobs` (job board and where each application
stands), `/cv`, `/jobreport`, `/skills`, `/finds` (price caps, pause, check
now) and `/casual` (which town, how far around it). The room search's commands (`/status`, `/review`, `/scan`, `/pause`, …)
are for the owner. Type `/` in the chat to see them.

## Set it up

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, an
[OpenAI API key](https://platform.openai.com/api-keys), a Telegram bot (make
one with [@BotFather](https://t.me/BotFather)) and Node.js 22.6 or newer.

1. **Fork this repo** and clone your fork.
2. **Make a Telegram group** and add your bot. For one topic per module, turn
   on Topics in the group's settings and make the bot an admin who may
   manage topics; it creates them itself.
3. **Describe your move:** copy `neustart.example.yaml` to `neustart.yaml` and
   fill it in: the city, who's looking for which jobs, your room profile.
   Every option is explained in the file. It's gitignored, so your CV and
   profile stay on your machine and in your own database.
4. **Run the setup:**

       cd cf
       npm install
       npm run setup

   It checks your config, asks for your keys (or reads them from `.env`),
   logs you in to Cloudflare, creates the database, deploys, connects
   Telegram and says hello in your group. The first posts come within half
   an hour.

Changed `neustart.yaml` later? `npm run config` stores it; the bot uses it from
its next tick, no deploy needed.

## How it's built

- **One Cloudflare Worker** in TypeScript on the free plan, with no server
  to run. Telegram reaches it through a webhook. D1 (Cloudflare's SQLite)
  holds the state and the config.
- **Four cron triggers, one per module.** A failure in one never stops
  another, and each has its own CPU budget.
- **Each tick does one small thing,** such as refreshing one search or
  rating two ads, so every run stays under the free plan's 10 ms CPU limit.
  Pages are parsed with regexes rather than a DOM parser for the same reason.
- **Rules come before AI.** Categories, title rules and the listing's own
  fields settle most items for free. Only what's left goes to an OpenAI
  model: a cheap one for rating and matching, a better one for writing.
- **It backs off politely.** When a site refuses requests, only that source
  waits and retries, for longer each time. The group hears about it only
  after 6 hours.
- **Tested end to end offline.** Besides unit tests, a golden run drives the
  whole bot for simulated hours (every trigger, command and button) against
  fake sites, a fake OpenAI and a fake Telegram, and checks that every
  request it makes and every row it leaves behind are exactly as recorded.

## Layout

    neustart.example.yaml   the config, documented; yours is neustart.yaml
    cf/src/index.ts         webhook, commands, cron dispatch, the room search
    cf/src/config.ts        reads and checks the config, fills in defaults
    cf/src/topics.ts        one forum topic per module, created on first use
    cf/src/scraper.ts       WG-Gesucht parsing
    cf/src/kleinanzeigen.ts Kleinanzeigen parsing
    cf/src/filters.ts       which room ads are worth a draft
    cf/src/writer.ts        reply drafts (prompt in prompt.ts)
    cf/src/finds.ts         bikes, bed, Kommode, rug, free stuff
    cf/src/findai.ts        rating the finds
    cf/src/jobs.ts          jobs: search, matching, cards, tracker, cover letters, reports
    cf/src/casual.ts        Minijobs
    cf/src/telegram.ts      the Telegram API calls it uses
    cf/scripts/             npm run setup and npm run config
    cf/test/                offline tests, and the golden run

More on running it day to day, and on how each module decides what to post:
**[cf/README.md](cf/README.md)**.

The project started as `wg-finder`, a room search for one move to Cottbus.
