import type { Redis } from "ioredis";

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetSeconds: number;
}

export interface RateLimiter {
  consume(apiKey: string): Promise<RateLimitResult>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limit = 100,
    private readonly windowSeconds = 60 * 60,
  ) {}

  async consume(apiKey: string): Promise<RateLimitResult> {
    const key = `rate-limit:${apiKey}`;
    const count = await this.redis.incr(key);

    if (count === 1) {
      await this.redis.expire(key, this.windowSeconds);
    }

    const ttl = await this.redis.ttl(key);
    const remaining = Math.max(this.limit - count, 0);

    return {
      allowed: count <= this.limit,
      limit: this.limit,
      remaining,
      resetSeconds: ttl > 0 ? ttl : this.windowSeconds,
    };
  }
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly requests = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 100,
    private readonly windowMs = 60 * 60 * 1000,
  ) {}

  consume(apiKey: string): Promise<RateLimitResult> {
    const now = Date.now();
    const current = this.requests.get(apiKey);
    const bucket =
      current && current.resetAt > now ? current : { count: 0, resetAt: now + this.windowMs };

    bucket.count += 1;
    this.requests.set(apiKey, bucket);

    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);

    return Promise.resolve({
      allowed: bucket.count <= this.limit,
      limit: this.limit,
      remaining: Math.max(this.limit - bucket.count, 0),
      resetSeconds,
    });
  }
}
