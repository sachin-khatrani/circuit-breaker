import { RACE_RULES } from '@circuit-breaker/shared';
import { showControls } from '../../game/actions';

const BINDINGS: [string, string, string][] = [
  ['Accelerate', 'W / ↑', 'RT'],
  ['Brake / reverse (hold)', 'S / ↓', 'LT'],
  ['Steer', 'A D / ← →', 'Left stick'],
  ['Drift (hold while steering)', 'Space', 'A / RB'],
  ['Boost burst (20 Energy)', 'Shift', 'X / LB'],
  ['Reset car', 'R', 'Y'],
  [`Shortcut: open the Needle (${RACE_RULES.shortcutCost} Energy)`, 'Q', 'D-pad ←'],
  [`Gate Shift: swap the split's lane (${RACE_RULES.gateCost})`, 'E', 'D-pad ↑'],
  [`Overdrive: 3 s super-boost (${RACE_RULES.overdriveCost})`, 'F', 'D-pad →'],
  ['Mute / unmute', 'M', '—'],
  ['Pause', 'Esc / P', 'Start'],
];

const TIPS = [
  'Each Shift press fires one boost burst for 20 Energy. The bar shows how many you have.',
  'Magenta pads on the road give a free burst. Glowing lanes on corner exits reward the right line.',
  'Hold a drift for 0.9 s for a mini-turbo, 2 s for a super mini-turbo. A long, clean drift also earns a little Energy.',
  'Press throttle in the last moment before GO for a perfect launch.',
  'Walls cost speed, not the race: the barrier deflects you along the track.',
  'Abilities spend the same Energy as boost. The Needle (Q) opens for everyone for 8 s; Gate Shift (E) swaps which Overload lane is open after a 2.5 s warning; Overdrive (F) runs 3 s faster than a burst. The ability slots also work by click or tap.',
];

export function ControlsOverlay() {
  return (
    <div className="absolute inset-0 flex items-start justify-center overflow-y-auto p-4 fade-in">
      <div className="scrim" />
      {/* my-auto centres the panel, yet a panel taller than the screen still scrolls from its top. */}
      <div className="panel scanlines relative my-auto w-full max-w-4xl p-6 sm:p-7">
        <h2 className="font-display text-2xl font-black tracking-[0.2em] text-white glow-cyan">
          CONTROLS
        </h2>
        <div className="mt-4 grid gap-x-8 gap-y-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <table className="w-full text-left">
            <thead>
              <tr className="label">
                <th className="pb-2 font-bold">Action</th>
                <th className="pb-2 font-bold">Keyboard</th>
                <th className="pb-2 font-bold">Gamepad</th>
              </tr>
            </thead>
            <tbody>
              {BINDINGS.map(([action, key, pad]) => (
                <tr key={action} className="border-t border-white/10">
                  <td className="py-1 pr-3 font-semibold text-white/85">{action}</td>
                  <td className="digits py-1 pr-3 text-sm font-bold whitespace-nowrap text-neon-cyan">
                    {key}
                  </td>
                  <td className="digits py-1 text-sm whitespace-nowrap text-neon-magenta">{pad}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <div className="label mb-2">Tips</div>
            <ul className="space-y-2 text-sm leading-snug text-white/75">
              {TIPS.map((tip) => (
                <li key={tip} className="flex gap-2">
                  <span className="text-neon-lime">›</span>
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <button type="button" className="btn mt-5" onClick={() => showControls(false)} autoFocus>
          Back
        </button>
      </div>
    </div>
  );
}
