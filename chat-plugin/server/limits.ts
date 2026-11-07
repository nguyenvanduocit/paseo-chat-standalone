// Token bucket: `burst` requests at once, refilled at `perSecond`. Kept in memory;
// a restart only resets the budget.
interface RateLimit { burst: number; perSecond: number }

export function rateLimiter(limit: RateLimit): (now: number) => boolean {
  let tokens = limit.burst;
  let at = 0;
  return now => {
    tokens = Math.min(limit.burst, tokens + (now - at) / 1000 * limit.perSecond);
    at = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}
