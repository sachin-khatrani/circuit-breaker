import {
  abilityCost,
  NICKNAME_MAX,
  normalizeRoomCode,
  RACE_RULES,
  ROOM_CODE_LENGTH,
  sanitizeNickname,
  type AbilityId,
} from '@circuit-breaker/shared';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { setQuality, showControls, startRace } from '../../game/actions';
import { formatTime } from '../../game/format';
import { ABILITY_KEYS } from '../../game/input';
import { createRoom, invitedRoomCode, joinRoom } from '../../game/multiplayer';
import { session } from '../../game/session';
import { QUALITY_PRESETS, type Quality } from '../../game/settings';
import { useGameStore } from '../../game/store';
import { AbilityIcon } from '../hud/AbilityBar';
import { ConnectionStatus } from '../online/ConnectionStatus';
import { ProfileStrip } from '../ranking/ProfileStrip';
import { SettingsControls } from '../SettingsControls';

const QUALITIES: Quality[] = ['low', 'medium', 'high'];

/** The three abilities, as the title screen explains them. */
const PRIMER: { id: AbilityId; name: string; text: string }[] = [
  { id: 'shortcut', name: 'Shortcut', text: 'Opens a hairpin shortcut, for every car' },
  { id: 'gate', name: 'Gate Shift', text: 'Swaps which lane of the split hairpin is open' },
  { id: 'overdrive', name: 'Overdrive', text: 'Three seconds of super-boost, just for you' },
];

/** The essentials of driving, for the small guide (the full list is under All controls). */
const KEYS: [string, string][] = [
  ['W A S D', 'drive'],
  ['Space', 'drift'],
  ['Shift', 'boost'],
  ['Q E F', 'abilities'],
];

/**
 * What the server will make of a typed nickname, before it is sent: the name it will show,
 * and a hint when the typing will be changed (or cannot be used).
 */
function checkNickname(raw: string): { name: string | null; hint: string | null } {
  if (raw.trim() === '') return { name: null, hint: null };
  const name = sanitizeNickname(raw);
  if (!name) return { name: null, hint: 'Use letters or numbers.' };
  const typed = raw.trim().replace(/\s+/g, ' ');
  return { name, hint: name === typed ? null : `You will race as “${name}”.` };
}

/**
 * ↑ / ↓ move focus between menu controls (not inside a text field). ↑ on the top control is
 * left alone: there it is the quick-start key.
 */
function navigateMenu(e: KeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (e.target instanceof HTMLInputElement) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-menu-item]')];
  const index = items.findIndex((item) => item === document.activeElement);
  if (index < 0 || (e.key === 'ArrowUp' && index === 0)) return;
  e.preventDefault();
  const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : index - 1;
  items[next].focus();
}

/** A mouse click hands focus back to the page so W / ↑ keep working as quick-start keys. */
function releaseFocusAfterClick(e: MouseEvent<HTMLButtonElement>): void {
  if (e.detail > 0) e.currentTarget.blur();
}

/**
 * Online play: a nickname, then a new room or a friend's by its code. What is typed is checked
 * here the way the server checks it, and the server's answer is shown as it comes.
 */
function OnlinePanel() {
  const savedName = useGameStore((s) => s.nickname);
  const busy = useGameStore((s) => s.online.busy);
  const error = useGameStore((s) => s.online.error);
  const intent = useGameStore((s) => s.entryIntent);
  const invited = invitedRoomCode();
  const [name, setName] = useState(savedName);
  const [code, setCode] = useState(() => invited ?? '');
  const codeField = useRef<HTMLInputElement>(null);
  const joinButton = useRef<HTMLButtonElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const nick = checkNickname(name);
  const codeOk = normalizeRoomCode(code) !== null;
  const codeHint =
    code.trim() !== '' && !codeOk ? 'Codes are 6 letters and digits (no 0, O, 1, I or L).' : null;

  // A name saved elsewhere (the profile panel) shows here too.
  const [shownSaved, setShownSaved] = useState(savedName);
  if (savedName !== shownSaved) {
    setShownSaved(savedName);
    setName(savedName);
  }

  // An invite link (or "Join room" from elsewhere) puts the cursor on the next step.
  useEffect(() => {
    if (!invited && intent !== 'join') return;
    if (!checkNickname(savedName).name) nameField.current?.focus();
    else if (invited) joinButton.current?.focus();
    else codeField.current?.focus();
  }, [invited, intent, savedName]);

  const join = (e: FormEvent) => {
    e.preventDefault();
    if (nick.name && codeOk) void joinRoom(code, name);
  };

  return (
    <section className="panel online-panel flex flex-col gap-3 p-4 sm:p-5" aria-label="Race online">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="label text-neon-cyan">Race online · 2 to 8 drivers</div>
        <ConnectionStatus />
      </div>
      {invited && (
        <div className="text-sm font-bold text-neon-lime">
          You are invited to room {invited}. Pick a nickname and join.
        </div>
      )}
      <label className="flex flex-col gap-1.5">
        <span className="label">Nickname</span>
        <input
          ref={nameField}
          className="field text-lg"
          value={name}
          maxLength={NICKNAME_MAX}
          placeholder="Your racing name"
          autoComplete="nickname"
          autoCapitalize="words"
          spellCheck={false}
          enterKeyHint="next"
          aria-invalid={name.trim() !== '' && !nick.name}
          aria-describedby="nickname-hint"
          onChange={(e) => setName(e.target.value)}
        />
        <span id="nickname-hint" className="min-h-[1.1rem] text-sm text-white/60">
          {nick.hint ?? `Letters, numbers, spaces and . _ - ' ! ? · up to ${NICKNAME_MAX}`}
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          className={`btn ${invited ? '' : 'btn-primary'} min-w-[170px] whitespace-nowrap`}
          disabled={busy || !nick.name}
          onClick={() => void createRoom(name)}
          data-menu-item
          autoFocus={intent === 'create'}
        >
          Create room
        </button>
        <span className="label text-white/45">or</span>
        <form className="flex gap-2" onSubmit={join}>
          <input
            ref={codeField}
            className="field w-[8.6rem] text-center text-lg tracking-[0.3em] uppercase"
            value={code}
            maxLength={ROOM_CODE_LENGTH * 2}
            placeholder="CODE"
            aria-label="Room code"
            aria-invalid={codeHint !== null}
            aria-describedby="code-hint"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="go"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button
            ref={joinButton}
            type="submit"
            className={`btn ${invited ? 'btn-primary' : ''} whitespace-nowrap`}
            disabled={busy || !nick.name || !codeOk}
            data-menu-item
          >
            Join room
          </button>
        </form>
      </div>
      <div className="min-h-[1.25rem]" aria-live="polite">
        {error ? (
          <div role="alert" className="font-bold tracking-wide text-neon-red">
            {error}
          </div>
        ) : busy ? (
          <div className="label text-white/60">Contacting the server…</div>
        ) : (
          <div id="code-hint" className="text-sm text-white/55">
            {codeHint ?? 'No account needed. Share the room code or link with friends.'}
          </div>
        )}
      </div>
      <ProfileStrip />
    </section>
  );
}

/** What makes the game different: the abilities that rewire the race, and the keys. */
function HowItWorks() {
  return (
    <section aria-label="How it works" className="flex flex-col gap-2">
      <div className="label text-white/60">Spend Energy to change the race</div>
      <ul className="grid gap-2">
        {PRIMER.map(({ id, name, text }) => (
          <li key={id} className="panel primer-card flex items-center gap-3 px-3 py-2">
            <span className="text-neon-cyan">
              <AbilityIcon id={id} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-display text-[0.78rem] font-bold tracking-[0.14em] text-white uppercase">
                {name}
              </span>
              <span className="block text-sm leading-snug text-white/72">
                {text} ·{' '}
                <span className="text-neon-lime">{abilityCost(RACE_RULES, id)} Energy</span>
              </span>
            </span>
            <kbd className="kbd">{ABILITY_KEYS[id]}</kbd>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5" aria-label="Controls">
        {KEYS.map(([keys, what]) => (
          <span key={what} className="flex items-center gap-1.5 text-sm text-white/70">
            <kbd className="kbd">{keys}</kbd>
            {what}
          </span>
        ))}
        <button type="button" className="chip" onClick={() => showControls(true)} data-menu-item>
          All controls
        </button>
      </div>
    </section>
  );
}

/** Title screen over the live attract-mode race. */
export function MainMenu() {
  const quality = useGameStore((s) => s.quality);
  const record = useGameStore((s) => s.record);
  const overlay = useGameStore((s) => s.overlay);
  const hidden = overlay !== 'none';

  return (
    <div className={`absolute inset-0 fade-in ${hidden ? 'pointer-events-none opacity-0' : ''}`}>
      <div className="absolute inset-0 bg-gradient-to-r from-ink/92 via-ink/45 to-ink/75" />
      <div className="relative h-full overflow-y-auto" onKeyDown={navigateMenu}>
        <div className="mx-auto flex min-h-full max-w-[1240px] flex-col justify-center gap-x-10 gap-y-5 px-5 py-5 sm:px-12 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex w-full max-w-[600px] flex-col gap-[clamp(0.7rem,2.2vh,1.3rem)]">
            <div>
              <div className="label mb-2 text-neon-magenta/90">Grid Zero // Night series</div>
              <h1 className="title-logo w-max max-w-full text-[clamp(2.2rem,min(7vw,9vh),5rem)]">
                CIRCUIT
                <br />
                BREAKER
              </h1>
              <p className="mt-3 text-xl font-bold tracking-wide text-white/90">
                Race your friends. Rewire the track.
              </p>
              <p className="mt-1 max-w-lg text-base font-medium tracking-wide text-white/65">
                Two to eight drivers on one neon circuit. Collect Energy as you drive, then choose:
                burn it on boosts, or open shortcuts and switch routes for everyone in the race.
              </p>
              <p className="touch-only-note mt-2 max-w-lg text-sm font-semibold text-neon-amber">
                On a touch screen? Racing needs a keyboard or a gamepad for now: there are no touch
                driving controls yet.
              </p>
            </div>
            <OnlinePanel />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                className="btn btn-ghost flex items-center gap-4"
                onClick={startRace}
                data-quick-start
                data-menu-item
              >
                <span>Practice solo</span>
                <span className="flex items-center gap-1.5" aria-hidden>
                  <kbd className="kbd">W</kbd>
                  <kbd className="kbd">↑</kbd>
                </span>
              </button>
              <span className="label text-white/50">
                Best · {session.laps} {session.laps === 1 ? 'lap' : 'laps'}{' '}
                <span className="digits text-white glow-cyan">{formatTime(record.bestTotal)}</span>{' '}
                · lap <span className="digits text-neon-magenta">{formatTime(record.bestLap)}</span>
              </span>
            </div>
          </div>

          <div className="flex w-full max-w-[600px] flex-col gap-4 lg:max-w-[380px]">
            <HowItWorks />
            <div className="flex flex-col gap-3">
              <div>
                <div className="label mb-2">Graphics</div>
                <div className="flex gap-1">
                  {QUALITIES.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="chip"
                      aria-pressed={quality === q}
                      data-menu-item
                      onClick={(e) => {
                        setQuality(q);
                        releaseFocusAfterClick(e);
                      }}
                    >
                      {QUALITY_PRESETS[q].label}
                    </button>
                  ))}
                </div>
              </div>
              <SettingsControls />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
