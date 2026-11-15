// Downloads every stored calibration from /api/export into data/calibrations-export.json, for
// retuning thresholds and feature weights on population data.
//
//   ADMIN_KEY=... npx tsx scripts/pull-data.ts [base-url] [out-file]
//
// base-url defaults to https://keyboard-warrior.johnmannul.workers.dev. The key is the one set
// with `npx wrangler secret put ADMIN_KEY` (or ADMIN_KEY in the Node server's environment).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const base = (process.argv[2] ?? 'https://keyboard-warrior.johnmannul.workers.dev').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'data/calibrations-export.json');
const key = process.env.ADMIN_KEY;
if (!key) {
  console.error('Set ADMIN_KEY in the environment.');
  process.exit(1);
}

const items: unknown[] = [];
let cursor: string | null = null;
do {
  const url = new URL('/api/export', base);
  url.searchParams.set('limit', '200');
  if (cursor) url.searchParams.set('cursor', cursor);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    console.error(`${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const page = (await res.json()) as { items: unknown[]; next: string | null };
  items.push(...page.items);
  cursor = page.next;
  process.stdout.write(`\r${items.length} calibrations`);
} while (cursor);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(items));
console.log(`\nwrote ${out}`);
