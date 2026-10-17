# 08 — Persistent Profiles, Rating and the Global Leaderboard

Status: **implemented in Step 8**. This document describes the database, the anonymous
identity, the rating rules, the leaderboard, and what happens when the database is away, as
the code does them. Section 10 lists what has to be set up outside the repository before the
global leaderboard is live in production.

Three numbers are easy to confuse, so the game keeps them apart everywhere:

| Name           | Lives                    | Comes from                                   | Resets                           |
|----------------|--------------------------|----------------------------------------------|----------------------------------|
| Race points    | one race's results       | the place in that race (100, 80, 65 … 10)    | every race                       |
| Session points | the room (server memory) | race points added up in that room            | New session, or the room closing |
| Rating         | the database             | rated races against other profiles (Elo)     | never                            |

## 1. Deployment, and where the data goes

The game is one Node 22 process (`apps/server/dist/index.js`, an esbuild bundle) that serves the
built client, Socket.IO, `/health` and now `/api/` on one port and one origin. Rooms, seats and
races live in its memory and do not survive a restart, by design. The repository has no hosting
configuration; the plan in `07-milestones.md` (M6) is one Render or Railway web service, whose
disk is wiped on every deploy.

So persistent data goes to **PostgreSQL**, a managed service next to that web service:

* Render PostgreSQL in the same region (the internal URL needs no TLS), Neon, or Railway
  PostgreSQL. Any PostgreSQL 13 or newer works; the code only needs a `DATABASE_URL`.
* Nothing else is added: no ORM, cache or queue service. The driver is `pg` (node-postgres)
  with its built-in pool.
* Cost: a free Neon project is enough for this game (at the time of writing it keeps its data,
  with a small storage limit). Render's free PostgreSQL expires after a trial period, so on
  Render a paid database is needed for data to last. Check each provider's current terms.

Room state is never written to the database. Only profiles, their sessions, and finished
rated races are stored; snapshots and inputs never are.

## 2. Schema

Migration 1 in `apps/server/src/db/migrations.ts` (SQL in TypeScript, so the bundle carries it):

```sql
CREATE TABLE players (
  id                  text PRIMARY KEY,          -- public, random: 16 characters, 80 bits
  nickname            text,                      -- null until first set
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_active_at      timestamptz NOT NULL DEFAULT now(),
  rating              integer NOT NULL DEFAULT 1000,
  peak_rating         integer NOT NULL DEFAULT 1000,
  races               integer NOT NULL DEFAULT 0, -- rated races, DNFs included
  finished            integer NOT NULL DEFAULT 0, -- rated races finished
  wins                integer NOT NULL DEFAULT 0,
  podiums             integer NOT NULL DEFAULT 0,
  best_lap_ms         integer,
  last_race_at        timestamptz,
  recovery_hash       text UNIQUE,               -- SHA-256 of the recovery code, if one was made
  recovery_created_at timestamptz,
  name_window_start   timestamptz,               -- nickname changes: 5 in 24 hours
  name_changes        integer NOT NULL DEFAULT 0,
  CONSTRAINT players_counts CHECK (
    0 <= wins AND wins <= podiums AND podiums <= finished AND finished <= races),
  CONSTRAINT players_rating CHECK (rating >= 0 AND peak_rating >= rating),
  CONSTRAINT players_nickname CHECK (nickname IS NULL OR char_length(nickname) BETWEEN 1 AND 16)
);
CREATE INDEX players_leaderboard ON players (rating DESC, wins DESC, created_at, id)
  WHERE races > 0;
CREATE INDEX players_nickname_search ON players (lower(nickname) text_pattern_ops)
  WHERE races > 0;

CREATE TABLE player_sessions (                   -- one row per browser holding the profile
  token_hash   text PRIMARY KEY,                 -- SHA-256 of the cookie token
  player_id    text NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_sessions_player ON player_sessions (player_id);

CREATE TABLE rated_races (
  id            uuid PRIMARY KEY,                -- made by the race server: the idempotency key
  room_code     text NOT NULL,
  session_id    integer NOT NULL,
  race_number   integer NOT NULL,
  track_id      text NOT NULL,
  laps          integer NOT NULL,
  field_size    integer NOT NULL,                -- cars in the race
  rated_players integer NOT NULL,
  started_at    timestamptz NOT NULL,
  completed_at  timestamptz NOT NULL,
  CONSTRAINT rated_races_size CHECK (rated_players BETWEEN 2 AND field_size AND field_size <= 8)
);

CREATE TABLE race_results (
  race_id       uuid NOT NULL REFERENCES rated_races (id) ON DELETE CASCADE,
  player_id     text NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  position      integer NOT NULL,                -- in the race's full classification
  finished      boolean NOT NULL,
  dnf_reason    text,                            -- 'left' | 'racing' | null
  total_time_ms integer,
  best_lap_ms   integer,
  rating_before integer NOT NULL,
  rating_delta  integer NOT NULL,
  rating_after  integer NOT NULL,
  stats         jsonb NOT NULL,                  -- the server's race stats for this car
  completed_at  timestamptz NOT NULL,
  PRIMARY KEY (race_id, player_id),              -- the result's unique id
  CONSTRAINT race_results_position CHECK (position BETWEEN 1 AND 8),
  CONSTRAINT race_results_rating CHECK (rating_after = rating_before + rating_delta),
  CONSTRAINT race_results_outcome CHECK (
    (finished AND dnf_reason IS NULL AND total_time_ms IS NOT NULL)
    OR (NOT finished AND dnf_reason IN ('left', 'racing') AND total_time_ms IS NULL))
);
CREATE INDEX race_results_player ON race_results (player_id, completed_at DESC);
```

Migration 2 (Step 9) replaces `players_leaderboard` with the same order as one ascending row:

```sql
CREATE INDEX players_rank ON players ((-rating), (-wins), created_at, id) WHERE races > 0;
DROP INDEX players_leaderboard;
```

`schema_migrations (version, name, checksum, applied_at)` records what has run.

What the indexes are for:
* `players_rank`: the leaderboard page, and a player's rank (a count of the rows ahead). With
  rating and wins negated, "ahead of me" is a single row comparison, one index range
  (`(-rating, -wins, created_at, id) < (…mine…)`).
* `players_nickname_search`: case-insensitive prefix search. A search takes its matches from
  this index first, then ranks the best 20 in one walk along `players_rank` (Step 9: at
  100,000 profiles, 2–62 ms instead of 45–112 ms; `09-security-audit.md` §7).
* `player_sessions` primary key: the cookie lookup on every profile request.
* `race_results_player`: a profile's recent races, and the rematch count of §5.
* `rated_races` primary key: a second write of the same race stops there.

## 3. Connection, configuration and migrations

`apps/server/src/db/` holds the pool (`db.ts`), the migrations (`migrations.ts`) and the
error classification (`errors.ts`). `.env.example` lists every setting.

| Variable            | Default                         | Meaning                                                |
|---------------------|---------------------------------|--------------------------------------------------------|
| `DATABASE_URL`      | unset: ranking is off           | `postgres://user:password@host:5432/db`, server only   |
| `DATABASE_SSL`      | `auto` (from the URL)           | `require` (TLS, certificate checked), `no-verify`, `off` |
| `DB_POOL_MAX`       | 5                               | connections the process may hold                       |
| `DB_MIGRATE`        | `auto`                          | `auto` runs pending migrations at boot; `off` never    |
| `TRUST_PROXY`       | 0                               | proxies in front (Render, Railway: `1`): client address and HTTPS from `X-Forwarded-*` |
| `COOKIE_SECURE`     | `auto` (HTTPS requests)         | `1` always, `0` never                                  |
| `CORS_ORIGIN`       | unset (same origin)             | a client on another origin: credentialed CORS and `SameSite=None` cookies |
| `TEST_DATABASE_URL` | unset                           | tests only: a database the tests may create schemas in |

The client has no secret. `VITE_SERVER_URL` exists only for a client built for another origin.
In development the server reads the repository's `.env` (git-ignored); in production the host's
environment settings provide the values.

* **Pool.** At most `DB_POOL_MAX` connections, 5 s to connect, a 5 s statement timeout (and a
  6 s client-side query timeout), idle connections closed after 30 s. An idle connection's
  error is logged, never fatal. Closing twice is harmless.
* **Migrations.** All pending migrations run in one transaction under a transaction-level
  advisory lock, so two servers starting at once cannot both migrate: the second waits, then
  finds nothing to do. A checksum per migration is stored, and a changed applied migration
  stops ranking from starting (the game still runs, unrated).
  * `npm run db:migrate -w @circuit-breaker/server` (development, via tsx), or
    `node apps/server/dist/dbcli.js migrate` with the built server.
  * `db:status` / `dbcli.js status` lists applied and pending versions.
  * `db:rollback -- --confirm` / `dbcli.js rollback --confirm` undoes the newest migration:
    migration 2's down puts the Step 8 index back; migration 1's down drops all four tables.
    Back up first.
  * With `DB_MIGRATE=auto` the server migrates at boot. While the database cannot be reached it
    retries every 15 s in the background, and races run unrated meanwhile.

## 4. Anonymous identity

No email, no password, no IP address stored (addresses are used in memory for rate limits only).

* **Profile id.** 16 characters of Crockford base32 from 80 random bits, made on the server.
  It is public: it appears in the leaderboard and in profile links. Its first four characters
  are the profile's **tag** ("Nova #K7Q2"), so two players with one name can be told apart, and
  an impersonator cannot choose the tag.
* **Session token.** 32 random bytes in an HTTP-only cookie `cb_player` (`SameSite=Lax`,
  `Secure` on HTTPS, `Path=/`, 400 days, renewed on use). The database keeps only its SHA-256.
  Page scripts never see it, it is never logged, and no response body contains it or its hash.
  An unknown or malformed cookie finds nothing and is cleared.
* **Created lazily.** A profile is made the first time a player creates or joins a room, not on
  every page view: `POST /api/identity`, at most 20 at once and 60 an hour per address (a room
  of friends behind one address still fits).
* **Into the race.** Socket.IO does not resend cookies after it connects, and a profile can
  change while the socket stays open (a recovery), so a seat gets its profile from a
  **ticket**. Before creating or joining a room, the page calls `POST /api/me/ticket` (the
  cookie identifies it). The answer is a random single-use ticket, valid for 60 s, held in
  server memory with the profile it stands for. The ticket goes with the create or join
  request, and the server binds the seat to that profile. Anything else the client sends (a
  profile id, a reused or made-up ticket) gives a seat without a profile.
* **Recovery code.** "Make a recovery code" shows a 20-character code once
  (`ABCDE-FGHJK-MNPQR-STVWX`, 100 bits), stored hashed. Entering it in another browser
  (`POST /api/identity/recover`, 10 tries an hour per address) signs that browser into the
  profile; case, spaces and dashes do not matter, and O, I and L read as 0, 1 and 1. Making a new
  code replaces the old one and signs out every other browser, which also locks out anyone who
  copied the old code.
* **Nickname.** The name typed for a room becomes the profile's name, at most 5 changes in a
  rolling 24 hours (naming an unnamed profile is free); the profile panel changes it too. Names
  are cleaned like room nicknames (NFKC; letters, numbers, a few separators; 16 characters).
  When the limit is reached, the player still races under the typed name in the room, the
  leaderboard keeps the old one, and the lobby says why.
* **Limits of anonymity.** Clearing site data, a private window or another device starts a new
  profile unless the recovery code is used. A lost code means a lost profile: there is no
  account to recover it through. Anyone holding the code can take the profile until the owner
  makes a new one. Profiles cost nothing, so one person can have several (§7).

### The API

Every answer is JSON with `cache-control: no-store`; errors are `{error}` with an HTTP status.
Writes need `content-type: application/json`, an `Origin` (when sent) of this site or
`CORS_ORIGIN`, and a body under 2 KB. Rate limits are per address, with `Retry-After` on 429.

| Method and path                 | Who                  | Answer                                              |
|---------------------------------|----------------------|-----------------------------------------------------|
| `GET /api/me`                   | anyone               | `{ranking, player}`: this browser's profile or null |
| `POST /api/identity`            | anyone               | `{player}` and the cookie (201 new, 200 existing)   |
| `POST /api/identity/recover`    | anyone               | `{player}` and a new cookie for that profile        |
| `POST /api/me/ticket`           | a browser with a profile | `{ticket, player, nicknameNote}`                 |
| `POST /api/me/nickname`         | a browser with a profile | `{player}`; 429 at the daily limit               |
| `POST /api/me/recovery-code`    | a browser with a profile | `{code, player}`, the code shown once            |
| `GET /api/leaderboard?offset&limit` | anyone           | `{total, offset, entries}` (limit 1–50, offset ≤ 10,000) |
| `GET /api/leaderboard/search?q` | anyone               | up to 20 ranked profiles whose name starts with `q` |
| `GET /api/players/:id`          | anyone               | public profile and its 10 most recent rated races   |

Public answers never include sessions, recovery details, last-active times or name-change
counters; only `/api/me` (the owner) does.

## 5. Rating

The rating is multiplayer Elo: a rated race counts as one head-to-head result against each
other rated player in it, and the results are averaged. Code:
`packages/shared/src/ranking/rating.ts` (pure, no I/O), applied by the server inside the
transaction of §6.

* **Start:** 1000. **Floor:** 100.
* **Result against each other rated player** (S):
  * finishing beats not finishing; between finishers the faster time wins (1 or 0); an
    exactly equal time is a draw (0.5);
  * between two non-finishers, a player who left loses to one still racing when the race was
    called; otherwise it is a draw.
* **Expected result:** E = 1 / (1 + 10^((opponent − rating) / 400)).
* **Change:** Δ = K / (N − 1) × Σ w × (S − E) over the N − 1 other rated players, rounded to a
  whole number (halves away from zero). K is 48 for a profile's first 10 rated races (so a new
  player finds their level quickly), then 32.
* **Bounds:** |Δ| ≤ K: at most 48 in one race, 32 for an established player. Beating a player
  rated far below you is worth almost nothing.
* **Two players or eight:** the same formula. Dividing by N − 1 makes any race worth at most
  K; a two-player race is plain Elo.
* **Rematches** (w): results against one opponent count fully for the first 5 rated races the
  two share in 24 hours, then half (5–9 already shared), a quarter (10–19), then not at all
  (20 and more). This stops two accounts from trading wins for rating.
* **Disconnects:** a player who disconnects and comes back keeps racing. A car whose player
  left, or did not come back within the 30 s grace, is a DNF that left. Leaving never takes a
  rated player out of a race.
* **Ties on the leaderboard:** rating (higher first), then wins (more first), then the older
  profile, then the profile id. Every rank is distinct.

A race is **rated** when all of these hold, and **unrated** otherwise (the reason is shown):
* it is an online race (solo practice never counts) and the server has ranking (a database);
* at least 2 players with profiles were on the grid, each in exactly one car (one profile in
  two tabs of a race: neither of its cars is rated);
* at least one of them finished.

Cars without a profile race and score session points as before, and take no part in the
head-to-head results. Wins and podiums count by the race's full classification.

## 6. Writing a race: once, completely, or not at all

When the server makes a race's results, the room hands the authoritative classification, and
the profile each car started with, to the ranking service. The client sends nothing: no
endpoint takes a position, a time or a rating. The race got a random UUID at its start: the
idempotency key.

The service writes races one at a time, in the order they finished. In one transaction:
1. `INSERT INTO rated_races … ON CONFLICT (id) DO NOTHING`. No row inserted means the race is
   already stored: the stored changes are returned and nothing is applied again. A second
   writer of the same race waits on the key until the first commits.
2. `SELECT … FROM players WHERE id = ANY(…) ORDER BY id FOR UPDATE` locks the rated players,
   always in the same order, so two races finishing at once wait for each other instead of
   overwriting or deadlocking.
3. The rematch counts for the window are read, and the changes are computed from the locked
   ratings.
4. `UPDATE players` (rating, peak, races, finished, wins, podiums, best lap, last race) and
   `INSERT INTO race_results`, one row per rated player.
5. `COMMIT`. Any error rolls back all of it.

The room sees **Saving global ratings…** until the commit returns, then each car's change and
its new global rank. A rating is never shown before the database has confirmed it.

## 7. Abuse and limits

| Threat                                       | Defence                                                                 |
|----------------------------------------------|-------------------------------------------------------------------------|
| Fake times, positions, wins or ratings       | No endpoint accepts them: the server's own results are the only input   |
| The same race counted twice (retry, reconnect, duplicate) | the race UUID is the primary key of `rated_races`; `(race_id, player_id)` is unique |
| Two races finishing at once                  | row locks in id order inside one transaction                            |
| Half-written results                         | one transaction; constraints check the counts and the rating arithmetic |
| Taking someone else's profile                | a 256-bit cookie token or a 100-bit recovery code; profile ids are public and prove nothing |
| A seat claiming a profile                    | only a server-issued, single-use, 60 s ticket binds one                  |
| Guessing recovery codes                      | 100 bits, and 10 tries an hour per address                              |
| Request floods                               | per-address token buckets on every endpoint (429 with `Retry-After`)    |
| Cross-site requests                          | JSON-only writes and an `Origin` check; `SameSite=Lax` cookie           |
| Impersonation by nickname                    | the tag beside every name; 5 name changes a day                          |
| Trading wins between two accounts            | rematch damping (§5); fresh profiles start at 1000, so beating them is worth little |

Not solved, and documented: one person running several profiles in one race to feed a main
profile is limited by the rematch rule and by Elo's expectation, but not detected. There is no
collusion analysis, no reserved names and no moderation tool.

## 8. When the database is away

The race server never waits for the database during a race.

* **Gameplay:** unaffected. Rooms, races, results and session points work exactly as before.
* **Profiles and leaderboard:** the API answers 503 "Rankings are unavailable right now. Races
  still work." and the menus say so. No internal detail is in the message.
* **Joining:** without a ticket the seat joins unrated, and the lobby says why.
* **A race that finishes:** its rating waits in an in-memory queue (up to 1000 races) and is
  retried after 2, 5, 10, 20 and 30 s, then every minute, for up to 10 minutes. The results
  screen says **Rating pending: the
  ranking database is unavailable. Retrying.** When the write commits, the room gets the
  rating; if it never does, the screen says **Rating not saved** and the server logs the race
  id. A rating is never shown as saved before it is.
* **A restart while ratings are pending** (or a crash) loses them: they were never shown as
  saved, and the shutdown log lists them. The queue is in memory because the deploy target's
  disk does not outlive a deploy either.
* **Shutdown** (SIGTERM): the server stops its rooms and Socket.IO, waits up to 5 s for a
  rating write in flight, logs any race still queued, then closes the pool.
* `/health` reports `ranking: {enabled, database: 'off' | 'starting' | 'ok' | 'down', pending}`,
  with no host or credential, and stays 200: a database outage must not get the game restarted.

## 9. Testing

* `packages/shared/test/rating.test.ts`: the rating formula (two and eight players, DNFs,
  draws, bounds over 2000 random races, the floor, order independence, rematch weights).
* `apps/server/test/ranking.store.test.ts`, `ranking.service.test.ts`, `api.test.ts`,
  `ranking.room.test.ts`: migrations, identity, recovery, names, tickets, rating once,
  rollback, concurrent races, leaderboard order, pages and search, the API's cookies, CORS,
  limits and errors, a database outage, rooms and sockets.
* Every database test runs on **PGlite** (PostgreSQL compiled to WebAssembly, in process), and
  also on a real PostgreSQL when `TEST_DATABASE_URL` is set. Each test works in a schema of its
  own with a random name, dropped afterwards; `TEST_DATABASE_URL` may not equal `DATABASE_URL`.
* The harness's `ranking` scenario runs three rated races over real sockets, with profiles made
  through the HTTP API.

A local PostgreSQL for development and tests (Docker; any free port):

```bash
docker run -d --name cb-pg -e POSTGRES_USER=cb -e POSTGRES_PASSWORD=change-me -e POSTGRES_DB=circuit_breaker -p 127.0.0.1:54329:5432 -v cb-pg-data:/var/lib/postgresql/data postgres:17-alpine
```

Then `docker exec cb-pg psql -U cb -d circuit_breaker -c "CREATE DATABASE circuit_breaker_test"`,
and in `.env`: `DATABASE_URL=postgres://cb:change-me@127.0.0.1:54329/circuit_breaker` and
`TEST_DATABASE_URL=postgres://cb:change-me@127.0.0.1:54329/circuit_breaker_test`.

## 10. Deployment

**Outside the repository** (the code cannot do these):
1. Create a PostgreSQL database (§1) in the same region as the web service.
2. Set `DATABASE_URL` on the web service as a secret, and `TRUST_PROXY=1` on Render or
   Railway. Never commit it: `.env` is ignored by git, and `.env.example` has no values.
3. Deploy (`npm run build`, `npm start`). With `DB_MIGRATE=auto` the first boot creates the
   tables: the log has `"scope":"db","msg":"migrations: applied 1, 2"` (a database already on
   Step 8 gets `applied 2`), and `/ready` shows `"database":"ok"`.
4. Verify persistence: race once with two browsers (both get profiles), restart the service,
   and check that both profiles, their history and the leaderboard are still there.

**Backups.** Use the provider's automated backups or point-in-time restore where the plan has
them. Before any migration, take a dump: `pg_dump --format=custom "$DATABASE_URL" > cb.dump`
(restore with `pg_restore --clean --dbname "$DATABASE_URL" cb.dump`).

**Rollback.**
* The Step 8 schema only adds tables, so the Step 7 build runs against it unchanged: rolling
  the app back is redeploying the previous build. (A Step 7 client cannot join a Step 8
  server: the protocol version differs, so deploy client and server together, as one build.)
* To remove the schema as well: back up, then `dbcli.js rollback --confirm` with the same
  `DATABASE_URL`.
* Without `DATABASE_URL` the server runs as before with ranking off, which is also the
  emergency switch if the database misbehaves.

**Cookies and origins.** The production page and the API share one origin, so the cookie is
first-party (`SameSite=Lax`). A client served from another origin needs `CORS_ORIGIN` set to
that origin, HTTPS on both, and `VITE_SERVER_URL` at its build; the server then sends
credentialed CORS headers and `SameSite=None; Secure` cookies. Browsers that block third-party
cookies will still refuse them, which is why one origin is the recommended setup.
