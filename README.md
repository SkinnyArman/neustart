# wg-finder (Cottbus)

A Telegram bot that runs on Cloudflare Workers (free plan) and watches
Kleinanzeigen and WG-Gesucht:

- **WG rooms:** reads each new ad and drafts a reply in the ad's language.
  You tap Approve and paste it yourself; nothing is ever sent to a landlord
  automatically.
- **Finds:** cheap or free bikes, a 140×200 bed, a Kommode, a rug, and free
  stuff for a student's room, each rated by AI and posted to its own forum
  topic.

All the code, setup and day-to-day notes are in **[cf/](cf/README.md)**.

`profile.yaml` (gitignored; start from `profile.example.yaml`) holds the
applicant profile and the searches. `cf/make-profile.sh` turns it into the
row the Worker reads from D1. `.env` (gitignored; see `.env.example`) holds
the keys for local scripts such as `cf/status.sh` and the tests.
