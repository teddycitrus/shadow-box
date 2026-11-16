// Opt-in sharing of calibration data, and the population prior built from everyone's shared data.
// Only motion measurements (17-number segment features, labels, verify scores) are sent; never
// video, images or anything about the player.
import { version as appVersion } from '../../../package.json';
import { DATA_VERSION, MAX_SAMPLES, handOf, isPrior, type CalibrationUpload, type Prior } from '../../../shared/calibration-data.ts';
import type { Stance, Target } from '../../../shared/types.ts';
import type { Sample } from './model.ts';
import type { Profile } from './teach.ts';

const PRIOR_TIMEOUT_MS = 8_000;

export interface UploadMeta {
  stance: Stance;
  fps: number;
  model: 'full' | 'lite';
}

export function toUpload(profile: Profile, meta: UploadMeta): CalibrationUpload {
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return {
    version: DATA_VERSION,
    id: crypto.randomUUID(),
    client: appVersion,
    stance: meta.stance,
    fps: Math.max(0, Math.min(240, Math.round(meta.fps * 10) / 10)),
    model: meta.model,
    samples: profile.samples.slice(-MAX_SAMPLES).map((s) => {
      const target = (s as Sample & { target?: Target }).target;
      return { hand: s.hand, label: s.label, v: s.v.map(r), ...(target && s.label === 'straight' ? { target } : {}) };
    }),
    scores: (profile.scores ?? []).map((m) => ({ id: m.id, ok: m.ok, tries: m.tries })),
    bodyDip: r(profile.bodyDip),
    defense: { duck: r(profile.defense.duck), slipLeft: r(profile.defense.slipLeft), slipRight: r(profile.defense.slipRight) },
  };
}

/**
 * Sends every finished calibration. Consent is collected outside the app (the event waiver), so
 * there is no in-app prompt; only anonymous motion measurements are sent, never video.
 */
export async function uploadCalibration(profile: Profile, meta: UploadMeta): Promise<boolean> {
  if (!profile.samples.some((s) => s.label !== 'none')) return false;
  return send(toUpload(profile, meta));
}

async function send(c: CalibrationUpload): Promise<boolean> {
  try {
    const res = await fetch('/api/calibration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) });
    return res.ok;
  } catch {
    return false;
  }
}

let prior: Prior | null = null;
let loading: Promise<Prior | null> | null = null;

/** Fetches the population prior once per page. Resolves null when it is unavailable. */
export function loadPrior(): Promise<Prior | null> {
  loading ??= (async () => {
    try {
      const res = await fetch(`/api/prior?version=${DATA_VERSION}`, { signal: AbortSignal.timeout(PRIOR_TIMEOUT_MS) });
      const body: unknown = res.ok ? await res.json() : null;
      prior = isPrior(body) && body.groups.length ? body : null;
    } catch {
      prior = null;
    }
    return prior;
  })();
  return loading;
}

/** The loaded prior as model samples for this stance, or undefined when there is none. */
export function priorSamples(stance: Stance, p: Prior | null = prior): Sample[] | undefined {
  if (!p) return undefined;
  const out = p.groups.flatMap((g) => g.samples.map((v): Sample => ({ hand: handOf(g.role, stance), label: g.label, v })));
  return out.length ? out : undefined;
}
