import { NICKNAME_CHANGES_PER_DAY, POINTS_TABLE, RATING_RULES } from '@circuit-breaker/shared';

const damped = RATING_RULES.rematchSteps.at(-1)!.from;
const ignored = RATING_RULES.rematchSteps[0].from;

/**
 * How the global rating works, and how it differs from the points a room hands out. The
 * numbers come from the rules the server applies.
 */
export function RatingRules() {
  return (
    <div className="grid gap-4 text-sm leading-snug text-white/75 sm:grid-cols-2">
      <div>
        <div className="label mb-1.5 text-neon-cyan">How rating works</div>
        <ul className="space-y-1.5">
          <li>
            Everyone starts at {RATING_RULES.initial}. A race is rated when at least two players
            with profiles race it online and one of them finishes; solo practice never counts.
          </li>
          <li>
            Each race counts as a duel with every other rated player: finishing ahead wins, an equal
            time draws, not finishing loses to every finisher, and leaving loses to a car still
            racing.
          </li>
          <li>
            Beating higher-rated players earns more. A race moves your rating by at most{' '}
            {RATING_RULES.kProvisional} in your first {RATING_RULES.provisionalRaces} rated races,
            then at most {RATING_RULES.k}.
          </li>
          <li>
            Racing the same opponent more than {damped} times in {RATING_RULES.rematchWindowHours}{' '}
            hours counts for less, and after {ignored} not at all.
          </li>
          <li>Equal ratings are ranked by wins, then by the older profile.</li>
        </ul>
      </div>
      <div>
        <div className="label mb-1.5 text-neon-magenta">Points are not rating</div>
        <ul className="space-y-1.5">
          <li>
            <span className="font-bold text-white">Race points</span> (
            {POINTS_TABLE.slice(0, 3).join(', ')}…) are for one race in one room.
          </li>
          <li>
            <span className="font-bold text-white">Session points</span> add those up while the room
            stays together, and start again with a new session.
          </li>
          <li>
            <span className="font-bold text-white">Rating</span> is global and permanent: it follows
            your profile across rooms and visits, and decides the leaderboard.
          </li>
          <li>
            Your profile is anonymous: no email, no password. Keep a recovery code to use it on
            another browser. Names can change {NICKNAME_CHANGES_PER_DAY} times a day.
          </li>
        </ul>
      </div>
    </div>
  );
}
