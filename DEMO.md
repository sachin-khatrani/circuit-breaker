# CIRCUIT BREAKER: two-minute demo

A live demo with real players: two people, each on their own computer and keyboard, racing
one lap against each other. Nothing in it is scripted or simulated; everything below is what
the game does today.

## Setup checklist

Do these before the audience arrives.

- [ ] **The game is running** at an address both computers can open:
  - deployed: open the game's URL a minute early (a free host may need up to a minute to wake
    up), then check `/ready` says `"ready":true`;
  - or locally: `npm run build`, then `npm start` (or `docker run`, see the README), and open
    `http://<this computer's IP>:3001` on both machines (the firewall must allow the port).
- [ ] **The database**, if the leaderboard is part of the demo: `/ready` shows
      `"database":"ok"`. Without one the races still run, unrated; skip the leaderboard at 1:55.
- [ ] **Two computers with keyboards** (a laptop each is ideal), both on the same version of
      the page. Chrome, Edge or Firefox, plugged in, other tabs closed. A phone cannot drive yet.
- [ ] **Sound on**: click once on each page (browsers start sound only after a click or key).
- [ ] **Graphics**: Medium; Low on an older laptop. Reduce motion off.
- [ ] **Nicknames** typed in advance (for example `Nova` and `Vex`), so the lobby takes seconds.
- [ ] **A fresh browser profile on the presenter's machine** shows the first-race tips (they
      explain Energy and the abilities). Close them with × if the screen should stay clean.
- [ ] **Rehearse the lap once.** The shortcut (the Needle) is on the left after the West
      hairpin, about two thirds round the lap; its sign reads `LOCKED · Q OPENS IT`. Press Q with
      45+ Energy about two seconds before the sign. The Overload split (Gate Shift, E) is the
      banked hairpin after the Skyway climb, about a third of the way round.

## Script (adapted to one lap of Grid Zero, about 55 to 65 seconds for a human driver)

| Time      | On screen                                                                                                                                                                                             | Say                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00–0:10 | The title page, with a live race running behind it. Point at the three ability cards.                                                                                                                 | "CIRCUIT BREAKER: two to eight players, one neon circuit. You collect Energy as you drive, then spend it on a boost, or on changing the track for everyone."       |
| 0:10–0:25 | Player A: **Create room**, **Copy invite link**. Player B opens the link (or types the code), **Join room**, **Ready**. A picks **1** lap and presses **Start race**.                                 | "No accounts: a nickname and a room code. The host starts when everyone is ready."                                                                                 |
| 0:25–0:35 | The race-start card, then 3-2-1-GO on both screens at the same moment.                                                                                                                                | "Both screens count down together; the server runs the race. Throttle just before GO for a launch boost."                                                          |
| 0:35–0:55 | T1 and the Esses: steer, hold Space to drift (the Energy bar fills, a mini-turbo fires), Shift for a boost burst.                                                                                     | "Green cells, drifts and the glowing lanes charge Energy. Shift spends 20 on a boost, but the same Energy pays for the abilities."                                 |
| 0:55–1:20 | At the Overload split, E: the gate's warning, then the other lane opens. After the West hairpin, Q: the Needle opens, and the other screen's feed says "Nova opened the shortcut!". Drive through it. | "Gate Shift swaps which lane of this hairpin is open, for everyone. Q opens the Needle, a shortcut, for eight seconds: for everyone, including the car behind me." |
| 1:20–1:40 | The run back to the line: the standings (top left) and POSITION change; F for Overdrive to pass.                                                                                                      | "Positions and laps come from the server. Overdrive is three seconds of super-boost, if you kept 40 Energy for it."                                                |
| 1:40–1:55 | FINISH, then the results on both screens: times, points, rating changes, race stats, the ability log.                                                                                                 | "Same results on every screen, decided by the server. Points add up over a session of races."                                                                      |
| 1:55–2:00 | **Leaderboard** (with a database) or the session points; **Race again**.                                                                                                                              | "Ratings are global and stay between visits. Race again starts the next race at once."                                                                             |

## If something goes wrong

- **"Cannot reach the game server."** The page loaded but the server did not answer: reload
  once; on a free host wait for it to wake, then try again.
- **A player drops mid-race.** Their car coasts on; reloading the page within 30 seconds puts
  them back in it.
- **Q does nothing.** The slot says what is missing: `Need +5` (collect a cell first),
  `Lock` (the shortcut just closed) or `Cool` (your own cooldown).
- **No rating on the results.** The database is missing or down: the race still counts for
  the session's points.
