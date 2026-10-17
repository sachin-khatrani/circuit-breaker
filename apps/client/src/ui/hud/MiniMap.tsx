import { gateLaneAt, PLAYER_COLORS, shortcutPhase } from '@circuit-breaker/shared';
import { useMemo, useRef } from 'react';
import { sectorColor } from '../../game/palette';
import { session } from '../../game/session';
import { useGameStore } from '../../game/store';
import { useAnimationFrame } from '../useAnimationFrame';

const PAD = 40;
const ROUTE_COLORS = { open: '#2bff9e', locked: '#ff3b4f', changing: '#ffb02e' } as const;

/**
 * North-up track map: sector-coloured outline, gates, the car as a heading arrow, (online)
 * every other car as a dot in its colour, and the changeable routes: the shortcut and the
 * split's two lanes, green when open, red when shut, amber while changing.
 */
export function MiniMap() {
  const track = session.track;
  const map = useMemo(() => {
    const b = track.bounds;
    const sectors = track.checkpoints.map((gate, i) => {
      const next = track.checkpoints[i + 1]?.s ?? track.length;
      let d = '';
      for (let s = gate.s; s <= next; s += track.spacing * 3) {
        const k = Math.min(track.count - 1, Math.round(s / track.spacing));
        d += `${d ? 'L' : 'M'}${track.px[k].toFixed(1)} ${track.pz[k].toFixed(1)} `;
      }
      const end = Math.round(next / track.spacing) % track.count;
      d += `L${track.px[end].toFixed(1)} ${track.pz[end].toFixed(1)}`;
      return { d, color: sectorColor(i) };
    });
    // The shortcut's centre line, and each split lane's centre line.
    const branch = track.branches[0];
    let shortcut = '';
    if (branch) {
      for (let i = 0; i < branch.count; i += 2) {
        shortcut += `${shortcut ? 'L' : 'M'}${branch.px[i].toFixed(1)} ${branch.pz[i].toFixed(1)} `;
      }
    }
    const split = track.splits[0];
    const lanes = ['', ''];
    if (split) {
      const point = { x: 0, y: 0, z: 0 };
      for (let k = 0; k < 2; k++) {
        for (let d = 0; d <= split.length; d += track.spacing * 3) {
          const s = split.s + d;
          const hw = track.halfWidth[Math.floor(track.wrapS(s) / track.spacing) % track.count];
          track.pointAt(s, (k === 0 ? -1 : 1) * (hw + split.divider) * 0.5, point);
          lanes[k] += `${lanes[k] ? 'L' : 'M'}${point.x.toFixed(1)} ${point.z.toFixed(1)} `;
        }
      }
    }
    return {
      viewBox: `${b.minX - PAD} ${b.minZ - PAD} ${b.maxX - b.minX + PAD * 2} ${b.maxZ - b.minZ + PAD * 2}`,
      sectors,
      gates: track.checkpoints.map((g) => ({ x: g.x, z: g.z, index: g.index })),
      shortcut,
      lanes,
    };
  }, [track]);
  const shortcutPath = useRef<SVGPathElement>(null);
  const lanePaths = useRef<(SVGPathElement | null)[]>([null, null]);

  const car = useRef<SVGGElement>(null);
  const next = useRef<SVGCircleElement>(null);
  const raceSerial = useGameStore((s) => s.raceSerial);
  const others = useMemo(() => {
    void raceSerial;
    return session.remotes.map((r) => ({ id: r.id, color: PLAYER_COLORS[r.color] ?? '#ffffff' }));
  }, [raceSerial]);
  const dots = useRef(new Map<string, SVGCircleElement>());

  useAnimationFrame(() => {
    const r = session.render;
    car.current?.setAttribute(
      'transform',
      `translate(${r.x.toFixed(1)} ${r.z.toFixed(1)}) rotate(${((-r.yaw * 180) / Math.PI).toFixed(1)})`,
    );
    for (const remote of session.remotes) {
      const dot = dots.current.get(remote.id);
      if (!dot) continue;
      dot.style.display = remote.visible ? '' : 'none';
      dot.setAttribute('cx', remote.sample.x.toFixed(1));
      dot.setAttribute('cy', remote.sample.z.toFixed(1));
    }
    const sim = session.sim;
    const course = sim.course;
    const phase = shortcutPhase(course, sim.tick, sim.rules);
    const shortcutColor =
      phase === 'open'
        ? ROUTE_COLORS.open
        : phase === 'locked'
          ? ROUTE_COLORS.locked
          : ROUTE_COLORS.changing;
    if (shortcutPath.current) {
      shortcutPath.current.setAttribute('stroke', shortcutColor);
      shortcutPath.current.setAttribute('stroke-dasharray', phase === 'locked' ? '14 12' : 'none');
    }
    const lane = gateLaneAt(course, sim.tick);
    const pending = course.gateSwitchTick >= 0 && sim.tick < course.gateSwitchTick;
    lanePaths.current.forEach((path, k) => {
      if (!path) return;
      const color = pending
        ? ROUTE_COLORS.changing
        : k === lane
          ? ROUTE_COLORS.open
          : ROUTE_COLORS.locked;
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-dasharray', !pending && k !== lane ? '10 10' : 'none');
    });
    const racer = session.racer;
    const gate = map.gates[racer.nextCheckpoint];
    if (next.current && gate) {
      next.current.setAttribute('cx', gate.x.toFixed(1));
      next.current.setAttribute('cy', gate.z.toFixed(1));
    }
  });

  return (
    <div className="panel p-2">
      <svg viewBox={map.viewBox} className="block h-[128px] w-[150px]" aria-label="Track map">
        {map.sectors.map((sector, i) => (
          <path
            key={`halo-${i}`}
            d={sector.d}
            fill="none"
            stroke={sector.color}
            strokeOpacity={0.25}
            strokeWidth={34}
            strokeLinejoin="round"
          />
        ))}
        {map.sectors.map((sector, i) => (
          <path
            key={i}
            d={sector.d}
            fill="none"
            stroke={sector.color}
            strokeWidth={12}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {map.gates.map((g) => (
          <circle
            key={g.index}
            cx={g.x}
            cy={g.z}
            r={g.index === 0 ? 16 : 11}
            fill="#07040f"
            stroke="#ffffff"
            strokeWidth={5}
          />
        ))}
        <circle
          ref={next}
          r={26}
          fill="none"
          stroke="#c6ff3a"
          strokeWidth={6}
          className="warning-pulse"
        />
        {others.map((o) => (
          <circle
            key={o.id}
            ref={(el) => {
              if (el) dots.current.set(o.id, el);
              else dots.current.delete(o.id);
            }}
            r={20}
            fill={o.color}
            stroke="#07040f"
            strokeWidth={6}
            style={{ display: 'none' }}
          />
        ))}
        {map.shortcut && (
          <path
            ref={shortcutPath}
            d={map.shortcut}
            fill="none"
            stroke={ROUTE_COLORS.locked}
            strokeWidth={9}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {map.lanes.map((d, k) =>
          d ? (
            <path
              key={k}
              ref={(el) => {
                lanePaths.current[k] = el;
              }}
              d={d}
              fill="none"
              stroke={ROUTE_COLORS.open}
              strokeWidth={6}
              strokeLinecap="round"
            />
          ) : null,
        )}
        <g ref={car}>
          <circle r={30} fill="rgb(255 255 255 / 0.15)" />
          <path
            d="M0 34 L-20 -18 L0 -6 L20 -18 Z"
            fill="#ffffff"
            stroke="#19e6ff"
            strokeWidth={6}
          />
        </g>
      </svg>
    </div>
  );
}
