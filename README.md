# neustart

A Telegram bot that helps two non-EU master's students settle in around
Cottbus. It looks for a WG room, cheap furniture and jobs, and posts what it
finds to a shared Telegram group, one forum topic per kind of thing. It runs
for free on Cloudflare Workers.

## What it does

| Topic | What it finds | Where from | AI |
|---|---|---|---|
| 🏠 **WG rooms** | New room ads around Cottbus. Each card has a "Draft reply" button that writes a reply in the ad's language from the applicant's profile. | WG-Gesucht, Kleinanzeigen | Only when you tap Draft |
| 🚲 🛏 🗄 🧶 **Finds** | Cheap adult bikes, a 140×200 bed, a Kommode and a rug within 30 km, each under its own price cap. | Kleinanzeigen | Rates what the rules let through, 1–10 |
| 🎁 **Free stuff** | Things worth picking up for a student's room. | Kleinanzeigen, "Zu verschenken" | Screens vague titles, rates the rest |
| 💼 **Jobs** | Werkstudent, internship and thesis jobs that match each person's profile, in Berlin, Cottbus or remote. Each card says who it fits, why, the gaps, the German level, the hours and the deadline. Buttons track each application from Applied to Offer. | Jobbörse (Arbeitsagentur), Arbeitnow | Matching; cover letters on tap |
| 🧺 **Casual jobs** | Minijobs around Cottbus (Aushilfe, Verkauf, Reinigung…), with the pay, the hours and the description. | Jobbörse, Minijob filter | None |

Nothing is ever sent to a landlord or an employer. The bot drafts, you send.

Commands everyone in the group can use: `/jobs` (job board and where each
application stands), `/cv`, `/jobreport`, `/skills` and `/finds` (price caps,
pause, check now). The WG commands (`/status`, `/review`, `/scan`, `/pause`,
…) are for the owner only. Type `/` in the chat to see the list.

## How it's built

- **One Cloudflare Worker** in TypeScript on the free plan, with no server
  to run. Telegram reaches it through a webhook. D1 (Cloudflare's SQLite)
  holds the state.
- **Four cron triggers, one per job:** WG rooms, finds, jobs and casual
  jobs. A failure in one never stops another, and each has its own CPU
  budget.
- **Each tick does one small thing,** such as refreshing one search or
  rating two ads, so every run stays under the free plan's 10 ms CPU limit.
  Pages are parsed with regexes rather than a DOM parser for the same reason.
- **Rules come before AI.** Categories, title rules and the listing's own
  fields settle most items for free. Only what's left goes to an OpenAI
  model: a cheap one for rating and matching, a better one for writing.
- **It backs off politely.** When a site refuses requests, only that source
  waits and retries, for longer each time. The group hears about it only
  after 6 hours.
- **Personal data stays out of the repo.** The applicant profile, CVs and
  skills live in D1 and are loaded from gitignored files.

## Layout

    cf/src/index.ts         webhook, commands, cron dispatch, the WG room search
    cf/src/scraper.ts       WG-Gesucht parsing
    cf/src/kleinanzeigen.ts Kleinanzeigen parsing
    cf/src/filters.ts       which room ads are worth a draft
    cf/src/writer.ts        reply drafts (prompt in prompt.ts)
    cf/src/finds.ts         bikes, bed, Kommode, rug, free stuff
    cf/src/findai.ts        rating the finds
    cf/src/jobs.ts          jobs: search, matching, cards, tracker, cover letters, reports
    cf/src/casual.ts        Minijobs around Cottbus
    cf/src/telegram.ts      the Telegram API calls it uses
    cf/test/                offline tests: synthetic pages, in-memory D1, recorded API calls

Setup, deploying and day-to-day notes are in **[cf/README.md](cf/README.md)**.

`profile.yaml` (gitignored; start from `profile.example.yaml`) holds the
applicant profile and the room searches; `cf/make-profile.sh` turns it into
the row the Worker reads from D1. `.env` (gitignored; see `.env.example`)
holds the keys for local scripts such as `cf/status.sh`.

The project started as `wg-finder`, a room search only. The Cloudflare
Worker and its database still use that name.
