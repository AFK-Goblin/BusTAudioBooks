// src/cache.js
// Small, dependency-free utilities: a TTL+LRU cache, a concurrency limiter, and
// a best-effort timeout wrapper. Used to keep the addon fast and to avoid
// hammering AudiobookBay / TorBox / metadata APIs with repeat work.

class TTLCache {
  constructor(defaultTtlMs = 5 * 60 * 1000, max = 1000) {
    this.def = defaultTtlMs;
    this.max = max;
    this.m = new Map();
  }
  get(key) {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.m.delete(key);
      return undefined;
    }
    // refresh recency (LRU)
    this.m.delete(key);
    this.m.set(key, e);
    return e.val;
  }
  set(key, val, ttlMs) {
    if (this.m.has(key)) this.m.delete(key);
    this.m.set(key, { val, exp: Date.now() + (ttlMs || this.def) });
    if (this.m.size > this.max) {
      const oldest = this.m.keys().next().value;
      this.m.delete(oldest);
    }
    return val;
  }
  has(key) {
    return this.get(key) !== undefined;
  }
}

// Wrap a function so at most `concurrency` calls run at once.
function pLimit(concurrency) {
  const queue = [];
  let active = 0;
  const next = () => {
    active--;
    if (queue.length) queue.shift()();
  };
  return (fn) =>
    (...args) =>
      new Promise((resolve, reject) => {
        const run = () => {
          active++;
          Promise.resolve(fn(...args)).then(resolve, reject).finally(next);
        };
        if (active < concurrency) run();
        else queue.push(run);
      });
}

// Resolve `fallback` if the promise doesn't settle in `ms`, or if it rejects.
// Perfect for best-effort enrichment that must never block the main response.
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(v);
    };
    const t = setTimeout(() => finish(fallback), ms);
    Promise.resolve(promise).then(finish, () => finish(fallback));
  });
}

// Retry an async fn with exponential backoff. For transient network hiccups on
// idempotent calls (scraping, metadata, read-only API calls).
async function withRetry(fn, { retries = 2, baseDelayMs = 200, factor = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = baseDelayMs * Math.pow(factor, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { TTLCache, pLimit, withTimeout, withRetry };
