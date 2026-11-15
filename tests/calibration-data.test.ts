import { describe, expect, it } from 'vitest';
import {
  FEATURE_COUNT, MAX_SAMPLES, PRIOR_PER_GROUP, addToReservoirs, computePrior, handOf, isPrior, representatives, roleOf, seeded,
  validateCalibration, type CalibrationUpload, type Reservoir,
} from '../shared/calibration-data.ts';
import { CalibrationStore, MemoryKV, UPLOADS_PER_HOUR, PRIOR_TTL_MS, type ApiRequest } from '../server/data-store.ts';
import { KnnModel, type Sample } from '../client/src/tracking/model.ts';

const rng = seeded(7);
const vec = (base: number) => Array.from({ length: FEATURE_COUNT }, (_, i) => base + i * 0.01 + rng() * 0.1);

function upload(over: Partial<CalibrationUpload> = {}): Record<string, unknown> {
  return {
    version: 5, id: `cal-${Math.floor(rng() * 1e9)}`, client: '0.1.0', stance: 'orthodox', fps: 30, model: 'full',
    samples: [
      { hand: 'left', label: 'straight', v: vec(1), target: 'body' },
      { hand: 'right', label: 'hook', v: vec(-1) },
      { hand: 'left', label: 'none', v: vec(0) },
    ],
    scores: [{ id: 'jab-head', ok: 2, tries: 2 }],
    bodySplit: { left: 0.8, right: 0.9 },
    defense: { duck: 0.5, slipLeft: 0.4, slipRight: 0.4 },
    ...over,
  };
}

describe('validateCalibration', () => {
  it('accepts a well formed upload and strips unknown fields', () => {
    const c = validateCalibration({ ...upload(), secret: 'x', samples: [{ hand: 'left', label: 'straight', v: vec(1), extra: 1 }] });
    expect(typeof c).toBe('object');
    const ok = c as CalibrationUpload;
    expect(ok).not.toHaveProperty('secret');
    expect(ok.samples[0]).not.toHaveProperty('extra');
  });

  it('keeps head/body targets on straights only', () => {
    const c = validateCalibration(upload({ samples: [
      { hand: 'left', label: 'straight', v: vec(1), target: 'body' },
      { hand: 'left', label: 'hook', v: vec(1), target: 'head' },
    ] })) as CalibrationUpload;
    expect(c.samples[0].target).toBe('body');
    expect(c.samples[1].target).toBeUndefined();
  });

  it.each([
    ['wrong version', { version: 4 }],
    ['bad id', { id: 'short' }],
    ['bad stance', { stance: 'boxer' }],
    ['fps out of range', { fps: 1000 }],
    ['bad model', { model: 'heavy' }],
    ['no samples', { samples: [] }],
    ['only non-punches', { samples: [{ hand: 'left', label: 'none', v: vec(0) }] }],
    ['too many samples', { samples: Array.from({ length: MAX_SAMPLES + 1 }, () => ({ hand: 'left', label: 'straight', v: vec(0) })) }],
    ['short vector', { samples: [{ hand: 'left', label: 'straight', v: [1, 2, 3] }] }],
    ['non-finite feature', { samples: [{ hand: 'left', label: 'straight', v: [...vec(0).slice(1), Infinity] }] }],
    ['huge feature', { samples: [{ hand: 'left', label: 'straight', v: [...vec(0).slice(1), 1e6] }] }],
    ['string feature', { samples: [{ hand: 'left', label: 'straight', v: [...vec(0).slice(1), '1'] }] }],
    ['bad label', { samples: [{ hand: 'left', label: 'kick', v: vec(0) }] }],
    ['ok above tries', { scores: [{ id: 'jab-head', ok: 3, tries: 2 }] }],
    ['bad score id', { scores: [{ id: '<script>', ok: 0, tries: 0 }] }],
    ['bad bodySplit', { bodySplit: { left: NaN, right: 0 } }],
  ])('rejects %s', (_, over) => {
    expect(typeof validateCalibration(upload(over as Partial<CalibrationUpload>))).toBe('string');
  });

  it('rejects non-objects', () => {
    for (const x of [null, 1, 'x', [], undefined]) expect(typeof validateCalibration(x)).toBe('string');
  });
});

describe('roles', () => {
  it('maps hands to lead/rear and back for both stances', () => {
    expect(roleOf('left', 'orthodox')).toBe('lead');
    expect(roleOf('left', 'southpaw')).toBe('rear');
    for (const stance of ['orthodox', 'southpaw'] as const) for (const hand of ['left', 'right'] as const) expect(handOf(roleOf(hand, stance), stance)).toBe(hand);
  });
});

describe('prior', () => {
  it('reservoirs stay bounded and pool stances by role', () => {
    const res = new Map<string, Reservoir>();
    const r = seeded(1);
    for (let i = 0; i < 50; i++) {
      const stance = i % 2 ? 'southpaw' : 'orthodox';
      const c = validateCalibration(upload({ stance, samples: Array.from({ length: 10 }, () => ({ hand: stance === 'orthodox' ? 'left' : 'right', label: 'straight', v: vec(1) })) })) as CalibrationUpload;
      addToReservoirs(res, c, r, 100);
    }
    expect([...res.keys()]).toEqual(['lead:straight']);
    expect(res.get('lead:straight')!.count).toBe(500);
    expect(res.get('lead:straight')!.items.length).toBe(100);
  });

  it('representatives returns k distinct real samples covering every cluster', () => {
    const vs = [...Array.from({ length: 60 }, () => vec(0)), ...Array.from({ length: 60 }, () => vec(10)), ...Array.from({ length: 60 }, () => vec(-10))];
    const reps = representatives(vs, 6, Array(FEATURE_COUNT).fill(1), seeded(3));
    expect(reps.length).toBe(6);
    expect(new Set(reps).size).toBe(6);
    for (const r of reps) expect(vs).toContain(r);
    for (const center of [0, 10, -10]) expect(reps.some((r) => Math.abs(r[0] - center) < 1)).toBe(true);
  });

  it('computePrior caps samples per group and reports stats', () => {
    const res = new Map<string, Reservoir>([
      ['lead:straight', { count: 300, items: Array.from({ length: 200 }, () => vec(1)) }],
      ['rear:hook', { count: 5, items: Array.from({ length: 5 }, () => vec(-1)) }],
    ]);
    const p = computePrior(res, 12, 1000, seeded(5));
    expect(isPrior(p)).toBe(true);
    expect(p.calibrations).toBe(12);
    expect(p.mean.length).toBe(FEATURE_COUNT);
    expect(p.groups.map((g) => `${g.role}:${g.label}`)).toEqual(['lead:straight', 'rear:hook']);
    expect(p.groups[0].samples.length).toBe(PRIOR_PER_GROUP);
    expect(p.groups[1].samples.length).toBe(5);
    expect(p.groups[0].mean[0]).toBeGreaterThan(0.9);
    expect(JSON.stringify(p).length).toBeLessThan(40_000);
  });
});

describe('CalibrationStore', () => {
  const req = (over: Partial<ApiRequest> & { raw?: string }): ApiRequest => ({
    method: 'GET', path: '/api/prior', search: new URLSearchParams('version=5'), ip: '1.2.3.4', auth: null, adminKey: undefined,
    body: async () => over.raw ?? '', ...over,
  });

  it('stores uploads, rate limits per IP and serves a cached prior', async () => {
    let t = 0;
    const store = new CalibrationStore(new MemoryKV(), () => t, seeded(9));
    const empty = await store.handle(req({}));
    expect(empty.status).toBe(200);
    expect((empty.body as { groups: unknown[] }).groups).toEqual([]);

    for (let i = 0; i < UPLOADS_PER_HOUR; i++) {
      const r = await store.handle(req({ method: 'POST', path: '/api/calibration', raw: JSON.stringify(upload()) }));
      expect(r.status).toBe(201);
    }
    const limited = await store.handle(req({ method: 'POST', path: '/api/calibration', raw: JSON.stringify(upload()) }));
    expect(limited.status).toBe(429);
    const other = await store.handle(req({ method: 'POST', path: '/api/calibration', ip: '5.6.7.8', raw: '{bad' }));
    expect(other.status).toBe(400);

    // Cached until the TTL passes, then rebuilt with the new data.
    expect(((await store.handle(req({}))).body as { groups: unknown[] }).groups).toEqual([]);
    t += PRIOR_TTL_MS;
    const prior = (await store.handle(req({}))).body as { calibrations: number; groups: unknown[] };
    expect(prior.calibrations).toBe(UPLOADS_PER_HOUR);
    expect(prior.groups.length).toBe(3);
    expect((await store.handle(req({ search: new URLSearchParams('version=4') }))).status).toBe(404);
  });

  it('ignores duplicate ids and leaves poorly verified calibrations out of the prior', async () => {
    const store = new CalibrationStore(new MemoryKV(), () => 0, seeded(2));
    const a = upload();
    expect((await store.submit(JSON.stringify(a), 'a')).status).toBe(201);
    expect((await store.submit(JSON.stringify(a), 'a')).body).toEqual({ ok: true, duplicate: true });
    expect((await store.submit(JSON.stringify(upload({ scores: [{ id: 'jab-head', ok: 0, tries: 4 }] })), 'a')).status).toBe(201);
    expect(((await store.getPrior('5')).body as { calibrations: number }).calibrations).toBe(1);
  });

  it('keeps the built prior per version and rebuilds it from the reservoirs after a bump', async () => {
    const kv = new MemoryKV();
    const store = new CalibrationStore(kv, () => 0, seeded(5));
    expect((await store.submit(JSON.stringify(upload()), 'a')).status).toBe(201);
    // A prior stored by the previous version is left alone and never served.
    kv.data.set('prior', { at: 0, value: { version: 4, updated: 0, calibrations: 1, mean: [], std: [], groups: [] } });
    const fresh = new CalibrationStore(kv, () => 0, seeded(5));
    const p = (await fresh.getPrior('5')).body as { version: number; calibrations: number; groups: unknown[] };
    expect(p.version).toBe(5);
    expect(p.calibrations).toBe(1);
    expect(p.groups.length).toBe(3);
    expect(kv.data.has('prior:v5')).toBe(true);
  });

  it('export is disabled without ADMIN_KEY and needs the bearer key', async () => {
    const store = new CalibrationStore(new MemoryKV(), () => 0, seeded(4));
    for (let i = 0; i < 3; i++) await store.submit(JSON.stringify(upload()), `ip${i}`);
    expect((await store.handle(req({ path: '/api/export' }))).status).toBe(404);
    expect((await store.handle(req({ path: '/api/export', adminKey: 'k', auth: 'Bearer nope' }))).status).toBe(401);
    const page1 = await store.handle(req({ path: '/api/export', adminKey: 'k', auth: 'Bearer k', search: new URLSearchParams('limit=2') }));
    const b1 = page1.body as { items: { day: string }[]; next: string };
    expect(b1.items.length).toBe(2);
    expect(b1.items[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const page2 = await store.handle(req({ path: '/api/export', adminKey: 'k', auth: 'Bearer k', search: new URLSearchParams(`limit=2&cursor=${b1.next}`) }));
    expect((page2.body as { items: unknown[]; next: null }).items.length).toBe(1);
  });
});

describe('KnnModel with a prior', () => {
  const own: Sample[] = [
    { hand: 'left', label: 'straight', v: vec(0) },
    { hand: 'left', label: 'straight', v: vec(0.2) },
    { hand: 'left', label: 'none', v: vec(3) },
    { hand: 'left', label: 'none', v: vec(3.2) },
  ];

  it('fills a move the player never taught', () => {
    const hook = vec(-3);
    const without = new KnnModel(own, 1, 100);
    const withPrior = new KnnModel(own, 1, 100, [{ hand: 'left', label: 'hook', v: vec(-3) }]);
    expect(without.predict('left', hook).label).not.toBe('hook');
    expect(withPrior.predict('left', hook).label).toBe('hook');
  });

  it('own samples win over an equally close prior sample', () => {
    // Along one feature: own straight at distance a, prior hook at a / 1.2 (nearer, but penalized by 1.3).
    const shift = (v: number[], d: number) => v.map((n, i) => (i === 0 ? n + d : n));
    const x = shift(own[0].v, 0.3);
    const m = new KnnModel(own, 1, 100, [{ hand: 'left', label: 'hook', v: shift(x, 0.3 / 1.2) }]);
    expect(m.predict('left', x).label).toBe('straight');
    const closer = new KnnModel(own, 1, 100, [{ hand: 'left', label: 'hook', v: shift(x, 0.3 / 1.5) }]);
    expect(closer.predict('left', x).label).toBe('hook');
  });
});
