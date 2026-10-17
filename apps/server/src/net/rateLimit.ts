/**
 * Token bucket: `capacity` messages in a burst, refilled at `ratePerSecond`. A connection that
 * keeps hitting the limit is dropped by the socket layer.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  /** Messages refused so far. */
  refused = 0;

  constructor(
    private readonly capacity: number,
    private readonly ratePerSecond: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    this.refused++;
    return false;
  }

  /** Back to a full burst: forgetting this bucket now changes nothing for its owner. */
  isFull(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }

  private refill(now: number): void {
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 1000) * this.ratePerSecond,
    );
    this.last = now;
  }
}

/**
 * Token buckets by key (an address and a kind of request). Buckets that have refilled are
 * forgotten from time to time, so the map holds only addresses that were busy recently.
 */
export class BucketMap {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly ratePerSecond: number,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  take(key: string, now: number): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.ratePerSecond, now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(now);
  }

  /** Drops every bucket that is full again (call it now and then). */
  sweep(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.isFull(now)) this.buckets.delete(key);
  }
}
