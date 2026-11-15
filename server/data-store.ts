// Calibration data store behind /api/calibration, /api/prior and /api/export. Runs in the
// Worker's DataDO (Durable Object storage) and in the Node dev server (a JSON file).
import {
  DATA_VERSION, MAX_BODY_BYTES, MIN_QUALITY, addToReservoirs, computePrior, quality, validateCalibration,
  type CalibrationUpload, type Prior, type Reservoir,
} from '../shared/calibration-data.ts';

export interface DataKV {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  list<T>(prefix: string, startAfter: string | undefined, limit: number): Promise<[string, T][]>;
}

export interface StoredCalibration extends CalibrationUpload {
  /** UTC day received. No time of day, IP or other request data is kept. */
  day: string;
}

export interface ApiRequest {
  method: string;
  path: string;
  search: URLSearchParams;
  ip: string;
  auth: string | null;
  adminKey: string | undefined;
  body(): Promise<string>;
}

export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export const PRIOR_TTL_MS = 5 * 60_000;
export const UPLOADS_PER_HOUR = 5;
export const UPLOADS_PER_DAY = 2_000;
const HOUR = 3_600_000;
const EXPORT_PAGE = 200;
/**
 * The built prior is stored per data version, so a version bump starts a fresh one instead of
 * serving the old version's (which clients reject). The reservoirs hold only segment features and
 * punch kinds, which did not change from version 4 to 5, so they carry over.
 */
const PRIOR_KEY = `prior:v${DATA_VERSION}`;

export class CalibrationStore {
  private res: Map<string, Reservoir> | null = null;
  private calibrations = 0;
  private prior: { at: number; value: Prior } | null = null;
  private dirty = true;
  private hits = new Map<string, number[]>();
  private daily = { day: '', n: 0 };
  /** Per-instance salt for the in-memory rate limit keys; never stored. */
  private readonly salt = crypto.randomUUID();

  constructor(private kv: DataKV, private now: () => number = Date.now, private rng: () => number = Math.random) {}

  async handle(req: ApiRequest): Promise<ApiResult> {
    if (req.path === '/api/calibration') return req.method === 'POST' ? this.submit(await req.body(), req.ip) : notAllowed();
    if (req.path === '/api/prior') return req.method === 'GET' ? this.getPrior(req.search.get('version')) : notAllowed();
    if (req.path === '/api/export') return req.method === 'GET' ? this.exportPage(req) : notAllowed();
    return { status: 404, body: { error: 'not found' } };
  }

  async submit(raw: string, ip: string): Promise<ApiResult> {
    if (raw.length > MAX_BODY_BYTES) return { status: 413, body: { error: 'too large' } };
    const t = this.now();
    const key = await this.ipKey(ip);
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < HOUR);
    if (recent.length >= UPLOADS_PER_HOUR) return { status: 429, body: { error: 'rate limited' }, headers: { 'Retry-After': '3600' } };
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    const day = new Date(t).toISOString().slice(0, 10);
    if (this.daily.day !== day) this.daily = { day, n: 0 };
    if (this.daily.n >= UPLOADS_PER_DAY) return { status: 503, body: { error: 'daily limit reached' } };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    const c = validateCalibration(parsed);
    if (typeof c === 'string') return { status: 400, body: { error: c } };
    await this.load();
    if (await this.kv.get(`cal:${c.id}`)) return { status: 200, body: { ok: true, duplicate: true } };
    this.daily.n++;
    const stored: StoredCalibration = { ...c, day };
    const writes: Record<string, unknown> = { [`cal:${c.id}`]: stored };
    if (quality(c) >= MIN_QUALITY) {
      for (const k of addToReservoirs(this.res!, c, this.rng)) writes[`res:${k}`] = this.res!.get(k);
      this.calibrations++;
      writes.meta = { calibrations: this.calibrations };
      this.dirty = true;
    }
    await this.kv.put(writes);
    return { status: 201, body: { ok: true } };
  }

  async getPrior(version: string | null): Promise<ApiResult> {
    if (version !== String(DATA_VERSION)) return { status: 404, body: { error: `no prior for version ${version ?? '(none)'}` } };
    const t = this.now();
    await this.load();
    if (!this.prior || (this.dirty && t - this.prior.at >= PRIOR_TTL_MS)) {
      // Rebuilt at most every PRIOR_TTL_MS and stored, so a restarted object does not redo it.
      this.prior = { at: t, value: computePrior(this.res!, this.calibrations, t, this.rng) };
      this.dirty = false;
      await this.kv.put({ [PRIOR_KEY]: this.prior });
    }
    return { status: 200, body: this.prior.value, headers: { 'Cache-Control': `public, max-age=${PRIOR_TTL_MS / 1000}` } };
  }

  async exportPage(req: ApiRequest): Promise<ApiResult> {
    if (!req.adminKey) return { status: 404, body: { error: 'export disabled' } };
    if (!sameString(req.auth ?? '', `Bearer ${req.adminKey}`)) return { status: 401, body: { error: 'unauthorized' } };
    const limit = Math.max(1, Math.min(EXPORT_PAGE, Number(req.search.get('limit')) || EXPORT_PAGE));
    const cursor = req.search.get('cursor') ?? undefined;
    const rows = await this.kv.list<StoredCalibration>('cal:', cursor, limit);
    return { status: 200, body: { items: rows.map(([, v]) => v), next: rows.length === limit ? rows.at(-1)![0] : null } };
  }

  private async load(): Promise<void> {
    if (this.res) return;
    const res = new Map<string, Reservoir>();
    for (const [k, v] of await this.kv.list<Reservoir>('res:', undefined, 64)) res.set(k.slice(4), v);
    this.calibrations = (await this.kv.get<{ calibrations: number }>('meta'))?.calibrations ?? 0;
    this.prior ??= (await this.kv.get<{ at: number; value: Prior }>(PRIOR_KEY)) ?? null;
    this.dirty = this.prior?.value.calibrations !== this.calibrations;
    this.res = res;
  }

  private async ipKey(ip: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.salt}|${ip}`));
    return [...new Uint8Array(d).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

function notAllowed(): ApiResult {
  return { status: 405, body: { error: 'method not allowed' } };
}

/** Length-independent string compare for the admin key. */
function sameString(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** In-memory DataKV, persisted by the caller (the Node dev server writes it to a JSON file). */
export class MemoryKV implements DataKV {
  constructor(readonly data: Map<string, unknown> = new Map(), private onWrite: () => void = () => {}) {}
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(entries: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) this.data.set(k, structuredClone(v));
    this.onWrite();
  }
  async list<T>(prefix: string, startAfter: string | undefined, limit: number): Promise<[string, T][]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort().slice(0, limit)
      .map((k) => [k, this.data.get(k) as T]);
  }
}
