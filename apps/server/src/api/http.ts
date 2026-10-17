import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { logger, newErrorId, type Logger } from '../log';
import type { Metrics } from '../metrics';
import { isHttps, requestAddress } from '../net/clientAddress';
import { fromOwnPage } from '../net/origin';
import { BucketMap } from '../net/rateLimit';
import { ApiFailure, type RankingService } from '../ranking/service';

/** The cookie that holds a browser's session token (HTTP-only: page scripts never see it). */
export const SESSION_COOKIE = 'cb_player';
/** 400 days, the longest a browser keeps a cookie; renewed whenever the profile is used. */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const MAX_BODY_BYTES = 2048;

export interface ApiOptions {
  /** A client served from another origin (CORS_ORIGIN): credentialed CORS, cross-site cookie. */
  corsOrigin?: string;
  /** Proxies in front of the server that set X-Forwarded-* (TRUST_PROXY). */
  trustProxyHops?: number;
  /** `auto`: Secure when the browser came over HTTPS. */
  cookieSecure?: 'auto' | boolean;
  /** Request budgets per address (tests lower them). */
  limits?: Partial<Record<LimitKind, { burst: number; perHour: number }>>;
  log?: Logger;
  metrics?: Metrics;
}

type LimitKind = 'read' | 'create' | 'recover' | 'write';

/**
 * Requests per address: a burst, then a steady rate. Trying recovery codes is the sensitive
 * one, so it gets the smallest budget; making profiles is limited too, but a room of eight
 * friends behind one address must still be able to make theirs.
 */
const LIMITS: Record<LimitKind, { burst: number; perHour: number }> = {
  read: { burst: 40, perHour: 3600 },
  write: { burst: 12, perHour: 1200 },
  create: { burst: 20, perHour: 60 },
  recover: { burst: 5, perHour: 10 },
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  // Only a script can send JSON, so a form on another site cannot post here.
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Bad JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Bad request.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * The ranking API under `/api/`: profiles (cookie-identified), recovery, the single-use seat
 * ticket, and the public leaderboard. Every answer is JSON; no answer carries a secret except
 * the Set-Cookie header and the one-time recovery code. Returns a request handler that says
 * whether it took the request.
 */
export function createApi(ranking: RankingService, options: ApiOptions = {}) {
  const hops = options.trustProxyHops ?? 0;
  const limits = { ...LIMITS, ...options.limits };
  const buckets = Object.fromEntries(
    (Object.keys(limits) as LimitKind[]).map((kind) => [
      kind,
      new BucketMap(limits[kind].burst, limits[kind].perHour / 3600),
    ]),
  ) as Record<LimitKind, BucketMap>;
  const log = options.log ?? logger;
  const metrics = options.metrics;
  const now = () => performance.now();

  // Addresses whose budget has refilled are forgotten, so the maps hold only recent callers.
  const sweep = setInterval(() => {
    for (const map of Object.values(buckets)) map.sweep(now());
  }, 60_000);
  sweep.unref();

  function limit(kind: LimitKind, req: IncomingMessage): void {
    if (!buckets[kind].take(requestAddress(req, hops), now())) {
      const wait = Math.ceil(3600 / limits[kind].perHour);
      throw new HttpError(429, 'Too many requests. Try again in a moment.', {
        'retry-after': String(wait),
      });
    }
  }

  function cookie(req: IncomingMessage, value: string | null): string {
    const crossSite = Boolean(options.corsOrigin);
    const secure =
      crossSite ||
      (options.cookieSecure === 'auto' || options.cookieSecure === undefined
        ? isHttps(req, hops)
        : options.cookieSecure);
    const parts = [
      `${SESSION_COOKIE}=${value ?? ''}`,
      'Path=/',
      'HttpOnly',
      // A client on another origin needs a cross-site cookie (and so HTTPS).
      crossSite ? 'SameSite=None' : 'SameSite=Lax',
      `Max-Age=${value === null ? 0 : COOKIE_MAX_AGE_S}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  /** Writes must come from this site's own pages (or the configured client origin). */
  function sameSite(req: IncomingMessage): void {
    if (!fromOwnPage(req.headers, options.corsOrigin)) {
      throw new HttpError(403, 'Requests must come from the game page.');
    }
  }

  function send(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string | string[]> = {},
  ): void {
    const cors: Record<string, string> = {};
    if (options.corsOrigin && req.headers.origin === options.corsOrigin) {
      cors['access-control-allow-origin'] = options.corsOrigin;
      cors['access-control-allow-credentials'] = 'true';
      cors.vary = 'Origin';
    }
    if (metrics) {
      if (status >= 500) metrics.api5xx++;
      else if (status >= 400) metrics.api4xx++;
    }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...cors,
      ...headers,
    });
    res.end(JSON.stringify(body));
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      const allowed = options.corsOrigin && req.headers.origin === options.corsOrigin;
      res.writeHead(allowed ? 204 : 403, {
        ...(allowed
          ? {
              'access-control-allow-origin': options.corsOrigin!,
              'access-control-allow-credentials': 'true',
              'access-control-allow-methods': 'GET, POST',
              'access-control-allow-headers': 'content-type',
              'access-control-max-age': '600',
              vary: 'Origin',
            }
          : {}),
      });
      res.end();
      return;
    }
    const token = readCookie(req, SESSION_COOKIE);
    const expect = (wanted: 'GET' | 'POST') => {
      if (method !== wanted) throw new HttpError(405, 'Method not allowed.', { allow: wanted });
    };

    if (path === '/api/me') {
      expect('GET');
      limit('read', req);
      if (!ranking.enabled) return send(req, res, 200, { ranking: false, player: null });
      const player = await ranking.me(token);
      // An unknown cookie (a deleted session) is cleared; a known one is renewed.
      const headers = token ? { 'set-cookie': cookie(req, player ? token : null) } : undefined;
      return send(req, res, 200, { ranking: true, player }, headers);
    }
    if (path === '/api/identity') {
      expect('POST');
      limit('create', req);
      sameSite(req);
      const body = await readJson(req);
      const made = await ranking.createIdentity(token, body.nickname);
      return send(
        req,
        res,
        made.created ? 201 : 200,
        { player: made.player },
        {
          'set-cookie': cookie(req, made.token),
        },
      );
    }
    if (path === '/api/identity/recover') {
      expect('POST');
      limit('recover', req);
      sameSite(req);
      const body = await readJson(req);
      const restored = await ranking.recover(token, body.code);
      return send(
        req,
        res,
        200,
        { player: restored.player },
        {
          'set-cookie': cookie(req, restored.token),
        },
      );
    }
    if (path === '/api/me/ticket') {
      expect('POST');
      limit('write', req);
      sameSite(req);
      const body = await readJson(req);
      return send(req, res, 200, await ranking.issueTicket(token, body.nickname));
    }
    if (path === '/api/me/nickname') {
      expect('POST');
      limit('write', req);
      sameSite(req);
      const body = await readJson(req);
      const result = await ranking.rename(token, body.nickname);
      if (!result.changed && result.note) throw new HttpError(429, result.note);
      return send(req, res, 200, { player: result.player });
    }
    if (path === '/api/me/recovery-code') {
      expect('POST');
      limit('write', req);
      sameSite(req);
      await readJson(req);
      return send(req, res, 200, await ranking.newRecoveryCode(token));
    }
    if (path === '/api/leaderboard') {
      expect('GET');
      limit('read', req);
      const page = await ranking.leaderboard(
        url.searchParams.get('offset') ?? 0,
        url.searchParams.get('limit') ?? 25,
      );
      return send(req, res, 200, page);
    }
    if (path === '/api/leaderboard/search') {
      expect('GET');
      limit('read', req);
      return send(req, res, 200, await ranking.search(url.searchParams.get('q') ?? ''));
    }
    const player = /^\/api\/players\/([^/]+)$/.exec(path);
    if (player) {
      expect('GET');
      limit('read', req);
      let id: string;
      try {
        id = decodeURIComponent(player[1]);
      } catch {
        throw new HttpError(404, 'No such player.');
      }
      return send(req, res, 200, await ranking.player(id));
    }
    throw new HttpError(404, 'Not found.');
  }

  return function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://local');
    } catch {
      return false;
    }
    if (!url.pathname.startsWith('/api/')) return false;
    const started = now();
    if (metrics) metrics.apiRequests++;
    route(req, res, url)
      .catch((error: unknown) => {
        if (res.headersSent) return;
        if (error instanceof HttpError) {
          return send(req, res, error.status, { error: error.message }, error.headers);
        }
        if (error instanceof ApiFailure) {
          const body =
            error.status === 503
              ? { error: error.message, ranking: ranking.enabled }
              : { error: error.message };
          return send(req, res, error.status, body);
        }
        // Unexpected: the details stay in the log; the caller gets an id to quote.
        const errorId = newErrorId();
        log.error('api', 'request failed', {
          method: req.method,
          path: url.pathname,
          errorId,
          error,
        });
        send(req, res, 500, { error: 'Something went wrong on the server.', errorId });
      })
      .finally(() => metrics?.apiLatency.record(now() - started));
    return true;
  };
}
