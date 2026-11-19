// Security helpers for VaraFinance `username-auth` Supabase Edge Function.
// Kept free of Deno-specific globals and remote URL imports so the exact same
// CORS allowlist and rate-limiting logic can be unit-tested in Vitest.

export type EnvGetter = (name: string) => string | undefined;

export interface CorsEvaluation {
  allowed: boolean;
  matchedOrigin: string | null;
  hasOriginHeader: boolean;
}

export interface RateLimitRule {
  name: string;
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

// Built-in origins strictly derived from this project's verified runtime/dev configuration:
// - Capacitor Android WebView (`capacitor.config.ts`: server.androidScheme = 'https')
// - Local Vite dev/preview (`package.json`: port 3000, standard Vite ports)
// - Current AI Studio dev & shared runtime origins
// Any custom/production domain MUST be configured via Edge Function secrets:
// `ALLOWED_ORIGINS` (comma-separated) and/or `APP_URL`.
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'https://ais-dev-du3mi2ureri4mq7bdtuwsg-258110201804.asia-northeast1.run.app',
  'https://ais-pre-du3mi2ureri4mq7bdtuwsg-258110201804.asia-northeast1.run.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://localhost',
  'capacitor://localhost',
];

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'capacitor:']);

export function normalizeAllowedOrigin(rawOrigin: string): string | null {
  const trimmed = rawOrigin.trim();
  if (!trimmed || trimmed.includes('*') || trimmed.toLowerCase() === 'null') {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    if (parsed.protocol === 'capacitor:') {
      return parsed.hostname ? `capacitor://${parsed.hostname.toLowerCase()}` : null;
    }
    // Reject credentials or non-origin leftovers that wouldn't match a browser Origin header
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function buildAllowedOriginSet(getEnv?: EnvGetter): Set<string> {
  const origins = new Set<string>();

  for (const builtin of DEFAULT_ALLOWED_ORIGINS) {
    const normalized = normalizeAllowedOrigin(builtin);
    if (normalized) {
      origins.add(normalized);
    }
  }

  if (getEnv) {
    const configuredList = getEnv('ALLOWED_ORIGINS') ?? '';
    for (const candidate of configuredList.split(',')) {
      const normalized = normalizeAllowedOrigin(candidate);
      if (normalized) {
        origins.add(normalized);
      }
    }

    const appUrl = getEnv('APP_URL') ?? '';
    const normalizedAppOrigin = normalizeAllowedOrigin(appUrl);
    if (normalizedAppOrigin) {
      origins.add(normalizedAppOrigin);
    }
  }

  return origins;
}

export function evaluateCorsOrigin(
  originHeader: string | null,
  allowedOrigins: ReadonlySet<string>
): CorsEvaluation {
  if (originHeader === null || originHeader.trim() === '') {
    return {
      allowed: true,
      matchedOrigin: null,
      hasOriginHeader: false,
    };
  }

  const normalized = normalizeAllowedOrigin(originHeader);
  if (!normalized || !allowedOrigins.has(normalized)) {
    return {
      allowed: false,
      matchedOrigin: null,
      hasOriginHeader: true,
    };
  }

  return {
    allowed: true,
    matchedOrigin: normalized,
    hasOriginHeader: true,
  };
}

export function buildCorsHeaders(
  matchedOrigin: string | null,
  options?: { isPreflight?: boolean }
): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
  };

  if (matchedOrigin) {
    headers['Access-Control-Allow-Origin'] = matchedOrigin;
    headers['Access-Control-Allow-Headers'] =
      'authorization, x-client-info, apikey, content-type';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    if (options?.isPreflight) {
      headers['Access-Control-Max-Age'] = '86400';
    }
  }

  return headers;
}

export function extractClientIp(headers: Headers): string {
  // Behind Supabase/Cloudflare edge proxies, cf-connecting-ip or x-real-ip are
  // preferred over x-forwarded-for (whose leftmost entry can include client-supplied values).
  const cfIp = headers.get('cf-connecting-ip');
  const realIp = headers.get('x-real-ip');
  const forwardedFor = headers.get('x-forwarded-for');

  const candidate =
    (cfIp && cfIp.trim()) ||
    (realIp && realIp.trim()) ||
    (forwardedFor && forwardedFor.split(',')[0]?.trim()) ||
    '';

  const sanitized = candidate
    .toLowerCase()
    .replace(/[^a-z0-9.:_-]/g, '')
    .slice(0, 64);

  return sanitized || 'unknown';
}

interface RateBucket {
  timestamps: number[];
  expiresAt: number;
}

/**
 * Bounded per-isolate sliding-window rate limiter.
 *
 * LIMITATIONS (by design — zero paid external store):
 * 1. State lives in the memory of a single Deno Edge Function isolate. Under concurrent
 *    traffic across multiple Edge instances/regions or after isolate cold-starts, limits
 *    are enforced per-isolate rather than globally.
 * 2. IP-derived keys rely on proxy headers (`cf-connecting-ip`, `x-real-ip`, `x-forwarded-for`)
 *    and can be affected by shared NATs or distributed client IPs.
 * 3. Should be paired with Supabase Auth built-in rate limits and (for strict global quotas)
 *    edge WAF rules or a shared datastore.
 */
export class IsolateRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly maxEntries: number;
  private readonly nowFn: () => number;

  constructor(options?: { maxEntries?: number; nowFn?: () => number }) {
    this.maxEntries = options?.maxEntries ?? 5000;
    this.nowFn = options?.nowFn ?? (() => Date.now());
  }

  consume(key: string, rule: RateLimitRule): RateLimitResult {
    const now = this.nowFn();
    const cutoff = now - rule.windowMs;
    const bucketKey = `${rule.name}:${key}`;

    const existing = this.buckets.get(bucketKey);
    const activeTimestamps = existing
      ? existing.timestamps.filter((ts) => ts > cutoff)
      : [];

    if (activeTimestamps.length >= rule.maxRequests) {
      const oldestInWindow = activeTimestamps[0] ?? now;
      const retryAfterMs = Math.max(1000, oldestInWindow + rule.windowMs - now);
      // Refresh entry timestamp tracking without adding a new blocked timestamp
      this.buckets.set(bucketKey, {
        timestamps: activeTimestamps,
        expiresAt: now + rule.windowMs,
      });
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    if (!existing && this.buckets.size >= this.maxEntries) {
      this.prune(now);
    }

    activeTimestamps.push(now);
    // Re-insert so Map maintains approximate recency order
    if (existing) {
      this.buckets.delete(bucketKey);
    }
    this.buckets.set(bucketKey, {
      timestamps: activeTimestamps,
      expiresAt: now + rule.windowMs,
    });

    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  }

  consumeAll(checks: ReadonlyArray<{ key: string; rule: RateLimitRule }>): RateLimitResult {
    // Evaluate all checks first? No — fail fast? Wait: evaluating all checks before committing
    // ensures a blocked secondary bucket doesn't unnecessarily pollute, or checking in order.
    // Checking read-only eligibility first prevents burning primary quota when secondary is blocked.
    const now = this.nowFn();
    let maxRetryAfter = 0;

    for (const { key, rule } of checks) {
      const check = this.peek(key, rule, now);
      if (!check.allowed) {
        maxRetryAfter = Math.max(maxRetryAfter, check.retryAfterSeconds);
      }
    }

    if (maxRetryAfter > 0) {
      return {
        allowed: false,
        retryAfterSeconds: maxRetryAfter,
      };
    }

    for (const { key, rule } of checks) {
      this.consume(key, rule);
    }

    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  }

  get size(): number {
    return this.buckets.size;
  }

  private peek(key: string, rule: RateLimitRule, now: number): RateLimitResult {
    const cutoff = now - rule.windowMs;
    const bucketKey = `${rule.name}:${key}`;
    const existing = this.buckets.get(bucketKey);
    if (!existing) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const activeTimestamps = existing.timestamps.filter((ts) => ts > cutoff);
    if (activeTimestamps.length >= rule.maxRequests) {
      const oldestInWindow = activeTimestamps[0] ?? now;
      const retryAfterMs = Math.max(1000, oldestInWindow + rule.windowMs - now);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private prune(now: number): void {
    for (const [k, bucket] of this.buckets.entries()) {
      if (bucket.expiresAt <= now) {
        this.buckets.delete(k);
      }
    }
    while (this.buckets.size >= this.maxEntries) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }
}

export const RATE_LIMIT_RULES = {
  checkUsernameByIp: {
    name: 'check_username_ip',
    maxRequests: 15,
    windowMs: 60_000, // 15 req / minute per IP (per isolate)
  },
  loginByIp: {
    name: 'login_ip',
    maxRequests: 15,
    windowMs: 300_000, // 15 attempts / 5 minutes per IP (per isolate)
  },
  loginByIpAndUser: {
    name: 'login_ip_user',
    maxRequests: 6,
    windowMs: 300_000, // 6 attempts / 5 minutes per IP + username (per isolate)
  },
  loginByUser: {
    name: 'login_user',
    maxRequests: 20,
    windowMs: 900_000, // 20 attempts / 15 minutes per username across IPs (per isolate)
  },
  resetByIp: {
    name: 'reset_ip',
    maxRequests: 5,
    windowMs: 900_000, // 5 requests / 15 minutes per IP (per isolate)
  },
  resetByIdentifier: {
    name: 'reset_id',
    maxRequests: 3,
    windowMs: 900_000, // 3 requests / 15 minutes per identifier (per isolate)
  },
  fallbackByIp: {
    name: 'fallback_ip',
    maxRequests: 30,
    windowMs: 60_000,
  },
} as const satisfies Record<string, RateLimitRule>;
