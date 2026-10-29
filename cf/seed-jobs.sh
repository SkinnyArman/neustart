#!/bin/bash
# Loads jobs-people.json (gitignored: profiles and CV text) into D1, where the
# jobs search reads it. Re-run after editing; skills changed with /skills in
# Telegram are kept separately and win over the file.
set -e
cd "$(dirname "$0")"
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const raw = JSON.stringify(JSON.parse(readFileSync('jobs-people.json', 'utf8')));
writeFileSync('jobs-people.sql',
  \"INSERT INTO kv (k,v) VALUES ('jobs_people','\" + raw.replaceAll(\"'\", \"''\") + \"') \" +
  'ON CONFLICT(k) DO UPDATE SET v=excluded.v;\n');
"
npx wrangler d1 execute wg-finder --remote --file=jobs-people.sql
