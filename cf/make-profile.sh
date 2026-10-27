#!/bin/bash
# Turns ../profile.yaml into profile.sql, which seeds the profile into D1.
# (It is ~4.5KB of JSON — too big for a Worker secret's 5.1KB limit.)
set -e
cd "$(dirname "$0")"

node --input-type=module -e "
import { parse } from 'yaml';
import { readFileSync, writeFileSync } from 'node:fs';
const raw = JSON.stringify(parse(readFileSync('../profile.yaml', 'utf8')));
const esc = raw.replaceAll(\"'\", \"''\");          // SQL-escape single quotes
writeFileSync('profile.sql',
  \"INSERT INTO kv (k,v) VALUES ('profile','\" + esc + \"')\n\" +
  'ON CONFLICT(k) DO UPDATE SET v=excluded.v;\n');
console.log('profile.sql written (' + raw.length + ' bytes of JSON)');
"

echo
echo "Now load it into D1:"
echo "  npx wrangler d1 execute wg-finder --remote --file=profile.sql"
