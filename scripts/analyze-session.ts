// Prints the timeline of a saved debug session: teach prompts, every motion and its decision,
// ignored motions on locked hands, and punches fired. Usage: npx tsx scripts/analyze-session.ts [file]
import { readdirSync, readFileSync, statSync } from 'node:fs';

const dir = 'tests/fixtures/sessions';
const file = process.argv[2] ?? readdirSync(dir).map((f) => `${dir}/${f}`).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const s = JSON.parse(readFileSync(file, 'utf8')) as {
  label: string; frames: { t: number }[]; marks: { t: number; kind: string; data?: any }[]; learned?: string[]; profile?: any;
};
const t0 = s.frames[0]?.t ?? 0;
const dur = ((s.frames.at(-1)?.t ?? 0) - t0) / 1000;
console.log(`${file}\n${s.label}: ${s.frames.length} frames, ${dur.toFixed(1)} s, ${(s.frames.length / dur).toFixed(1)} fps`);
const counts: Record<string, number> = {};
for (const m of s.marks) {
  counts[m.kind] = (counts[m.kind] ?? 0) + 1;
  const ts = ((m.t - t0) / 1000).toFixed(2).padStart(7);
  if (m.kind === 'teachStep') console.log(`${ts} ---- prompt: ${m.data?.prompt ?? 'done'}`);
  else if (m.kind === 'decision') console.log(`${ts} ${m.data.seg.hand.padEnd(5)} ${m.data.punch ? 'FIRE ' : '     '}${m.data.why}`);
  else if (m.kind === 'ignored') console.log(`${ts} ${m.data.hand.padEnd(5)} IGNORED ${m.data.why}`);
  else if (m.kind === 'defense') console.log(`${ts}       defense ${JSON.stringify(m.data)}`);
  else if (m.kind !== 'punch') console.log(`${ts} ${m.kind} ${m.data ? JSON.stringify(m.data).slice(0, 160) : ''}`);
}
console.log(counts);
