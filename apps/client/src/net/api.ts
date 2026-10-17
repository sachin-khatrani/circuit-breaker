import type {
  LeaderboardResponse,
  MeResponse,
  PlayerResponse,
  ProfileResponse,
  RecoveryCodeResponse,
  SearchResponse,
  TicketResponse,
} from '@circuit-breaker/shared';

/** The game server: the page's own origin, unless the client was built for another one. */
export const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? '';

/** A refusal or failure of the ranking API, with the server's message for the player. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server has no ranking at all (no database configured). */
    readonly rankingOff = false,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 8000;

/**
 * One request to the ranking API. The session cookie goes along by itself (it is HTTP-only:
 * this code never sees it). Answers are JSON; an error answer becomes an ApiError.
 */
async function call<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(SERVER_URL + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: SERVER_URL ? 'include' : 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the game server.');
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: handled below
  }
  if (!res.ok) {
    const error = data as { error?: unknown; ranking?: unknown } | null;
    throw new ApiError(
      res.status,
      typeof error?.error === 'string' ? error.error : 'Something went wrong on the server.',
      error?.ranking === false,
    );
  }
  return data as T;
}

export const api = {
  me: () => call<MeResponse>('/api/me'),
  createIdentity: (nickname: string | null) => call<ProfileResponse>('/api/identity', { nickname }),
  recover: (code: string) => call<ProfileResponse>('/api/identity/recover', { code }),
  ticket: (nickname: string) => call<TicketResponse>('/api/me/ticket', { nickname }),
  rename: (nickname: string) => call<ProfileResponse>('/api/me/nickname', { nickname }),
  recoveryCode: () => call<RecoveryCodeResponse>('/api/me/recovery-code', {}),
  leaderboard: (offset: number, limit: number) =>
    call<LeaderboardResponse>(`/api/leaderboard?offset=${offset}&limit=${limit}`),
  search: (query: string) =>
    call<SearchResponse>(`/api/leaderboard/search?q=${encodeURIComponent(query)}`),
  player: (id: string) => call<PlayerResponse>(`/api/players/${encodeURIComponent(id)}`),
};
