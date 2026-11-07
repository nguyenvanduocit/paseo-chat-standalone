//! Token buckets by key (a handle, or a conversation): `burst` requests at once, refilled at `per_second`. Kept in
//! memory; a restart only resets the budget. The same arithmetic as `chat-plugin/server/limits.ts`.

use std::collections::HashMap;

#[derive(Clone, Copy, Debug)]
pub struct RateLimit {
    pub burst: f64,
    pub per_second: f64,
}

/// Stops a looping agent, not a person typing.
pub const SEND_LIMIT: RateLimit = RateLimit {
    burst: 20.0,
    per_second: 1.0,
};
/// Messages agents (`via`) send in one conversation, on every side together: a burst for a working exchange, then
/// one every 30 seconds, so agents prompting each other slow down instead of looping at `SEND_LIMIT`.
pub const AGENT_SEND_LIMIT: RateLimit = RateLimit {
    burst: 20.0,
    per_second: 1.0 / 30.0,
};
pub const UPLOAD_LIMIT: RateLimit = RateLimit {
    burst: 10.0,
    per_second: 0.2,
};

struct Bucket {
    tokens: f64,
    at: i64,
}

pub struct RateLimiter {
    limit: RateLimit,
    buckets: HashMap<String, Bucket>,
}

impl RateLimiter {
    pub fn new(limit: RateLimit) -> RateLimiter {
        RateLimiter {
            limit,
            buckets: HashMap::new(),
        }
    }

    /// Takes one token from `key`'s bucket at `now_ms`; when it is empty, the milliseconds until it holds one.
    pub fn take(&mut self, key: &str, now_ms: i64) -> Result<(), i64> {
        let limit = self.limit;
        let bucket = self.buckets.entry(key.to_owned()).or_insert(Bucket {
            tokens: limit.burst,
            at: 0,
        });
        // A clock stepped back refills nothing rather than draining the bucket.
        let elapsed = (now_ms - bucket.at).max(0);
        bucket.tokens = limit
            .burst
            .min(bucket.tokens + elapsed as f64 / 1000.0 * limit.per_second);
        bucket.at = now_ms;
        if bucket.tokens < 1.0 {
            return Err(((1.0 - bucket.tokens) / limit.per_second * 1000.0).ceil() as i64);
        }
        bucket.tokens -= 1.0;
        Ok(())
    }
}
