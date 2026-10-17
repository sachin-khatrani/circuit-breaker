/**
 * Estimates the server's clock from ping round trips (NTP style). Each sample gives
 * `offset = serverTime + rtt/2 − receiveTime`; the samples with the lowest round trip are the
 * most trustworthy (least queueing), so the estimate averages the best few of the recent ones.
 * Small corrections are slewed in gradually so interpolation never jumps; big ones snap.
 */
export class ClockSync {
  /** Estimated server time = local time + offset (ms). */
  offset = 0;
  /** Smoothed round-trip time (ms), and its recent spread (jitter). */
  rtt = 0;
  jitter = 0;
  samples = 0;
  private readonly recent: { offset: number; rtt: number }[] = [];
  private target = 0;

  constructor(
    private readonly keep = 10,
    private readonly best = 3,
    /** Corrections larger than this (ms) snap instead of slewing. */
    private readonly snapMs = 120,
  ) {}

  /** `sent` and `received` are local times, `serverTime` the server's clock in its reply. */
  addSample(sent: number, serverTime: number, received: number): void {
    const rtt = Math.max(0, received - sent);
    const offset = serverTime + rtt / 2 - received;
    this.recent.push({ offset, rtt });
    if (this.recent.length > this.keep) this.recent.shift();
    const ranked = [...this.recent].sort((a, b) => a.rtt - b.rtt).slice(0, this.best);
    this.target = ranked.reduce((sum, s) => sum + s.offset, 0) / ranked.length;
    const rtts = this.recent.map((s) => s.rtt);
    const mean = rtts.reduce((a, b) => a + b, 0) / rtts.length;
    this.rtt = this.samples === 0 ? rtt : this.rtt + (mean - this.rtt) * 0.3;
    this.jitter = Math.sqrt(rtts.reduce((a, r) => a + (r - mean) * (r - mean), 0) / rtts.length);
    if (this.samples === 0 || Math.abs(this.target - this.offset) > this.snapMs) {
      this.offset = this.target;
    }
    this.samples++;
  }

  /** Slews the offset toward the latest estimate (call every frame with the frame time). */
  update(dtMs: number): void {
    const gap = this.target - this.offset;
    // At most 5 % of real time: a 20 ms correction takes 0.4 s and never reverses time.
    const step = Math.min(Math.abs(gap), dtMs * 0.05);
    this.offset += Math.sign(gap) * step;
  }

  serverNow(localNow: number): number {
    return localNow + this.offset;
  }
}

/**
 * How many ticks ahead of the server the client simulates (and stamps its inputs), so every
 * input reaches the server before the tick it belongs to. It starts from the measured round
 * trip, then follows the server's feedback (`buffer`: how many ticks early the newest input
 * arrived; `missed`: ticks the server had no input). Late inputs push it up at once; a big
 * cushion lets it drift down slowly enough that the client's clock never visibly stalls.
 */
export class InputLead {
  lead: number;
  private raisedAt = -Infinity;

  constructor(
    initial = 6,
    readonly min = 2,
    readonly max = 40,
    /** Ticks of cushion to aim for on the server. */
    readonly cushion = 2,
  ) {
    this.lead = initial;
  }

  /** A first estimate from the ping: one way, plus jitter, plus the cushion. */
  fromRtt(rttMs: number, jitterMs: number, tickMs: number): void {
    const oneWay = (rttMs / 2 + 2 * jitterMs) / tickMs;
    this.lead = Math.min(this.max, Math.max(this.min, Math.ceil(oneWay) + this.cushion));
  }

  /**
   * Feedback from a snapshot. A raise needs a round trip to show in the feedback, so further
   * raises wait that long (otherwise every snapshot already in flight would add another).
   */
  feedback(buffer: number, missed: number, nowMs: number, rttMs: number): void {
    const short = this.cushion - buffer;
    if (missed > 0 || short > 0) {
      if (nowMs - this.raisedAt < rttMs + 100) return;
      this.lead += Math.max(1, Math.min(6, short + (missed > 0 ? 1 : 0)));
      this.raisedAt = nowMs;
    } else if (buffer > this.cushion + 2) {
      this.lead -= 0.05;
    }
    this.lead = Math.min(this.max, Math.max(this.min, this.lead));
  }
}
