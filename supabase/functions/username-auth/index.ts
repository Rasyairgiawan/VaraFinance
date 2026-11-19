// VaraFinance Supabase Edge Function: username-auth
// Server-side broker for username-based login, availability check, and password reset
// WITHOUT exposing recovery_email or allowing public username/email enumeration RPCs.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildAllowedOriginSet,
  buildCorsHeaders,
  evaluateCorsOrigin,
  extractClientIp,
  IsolateRateLimiter,
  RATE_LIMIT_RULES,
} from './security.ts';

const USERNAME_REGEX = /^[a-z0-9._]{3,24}$/;

// Bounded per-isolate limiter. See `./security.ts` for scope & limitations:
// state is local to each Deno isolate (not globally shared across Edge instances).
const rateLimiter = new IsolateRateLimiter({ maxEntries: 5000 });

function jsonResponse(
  body: unknown,
  status = 200,
  corsHeaders: Record<string, string> = { Vary: 'Origin' },
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(extraHeaders ?? {}),
    },
  });
}

function rateLimitedResponse(
  retryAfterSeconds: number,
  corsHeaders: Record<string, string>
): Response {
  return jsonResponse(
    { error: 'Terlalu banyak permintaan. Silakan coba lagi beberapa saat lagi.' },
    429,
    corsHeaders,
    { 'Retry-After': String(Math.max(1, retryAfterSeconds)) }
  );
}

Deno.serve(async (req: Request) => {
  const allowedOrigins = buildAllowedOriginSet((name) => Deno.env.get(name));
  const corsEval = evaluateCorsOrigin(req.headers.get('origin'), allowedOrigins);
  const corsHeaders = buildCorsHeaders(corsEval.matchedOrigin, {
    isPreflight: req.method === 'OPTIONS',
  });

  if (req.method === 'OPTIONS') {
    if (!corsEval.allowed) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, { Vary: 'Origin' });
    }
    return new Response(null, {
      status: corsEval.hasOriginHeader ? 204 : 400,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'no-store',
      },
    });
  }

  if (!corsEval.allowed) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, { Vary: 'Origin' });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: 'Server auth configuration missing' }, 500, corsHeaders);
  }

  const clientIp = extractClientIp(req.headers);

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const supabasePublic = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const payload = await req.json();
    const action = typeof payload?.action === 'string' ? payload.action : '';

    if (action === 'check_username') {
      const limit = rateLimiter.consumeAll([
        { key: clientIp, rule: RATE_LIMIT_RULES.checkUsernameByIp },
      ]);
      if (!limit.allowed) {
        return rateLimitedResponse(limit.retryAfterSeconds, corsHeaders);
      }

      const normalized =
        typeof payload?.username === 'string' ? payload.username.trim().toLowerCase() : '';
      if (!USERNAME_REGEX.test(normalized)) {
        return jsonResponse({ available: false }, 400, corsHeaders);
      }

      const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('username_normalized', normalized)
        .maybeSingle();

      if (error) {
        return jsonResponse({ error: 'Failed to verify username' }, 500, corsHeaders);
      }
      return jsonResponse({ available: !data }, 200, corsHeaders);
    }

    if (action === 'login') {
      const normalized =
        typeof payload?.username === 'string' ? payload.username.trim().toLowerCase() : '';
      const password = typeof payload?.password === 'string' ? payload.password : '';

      // Enforce rate limit BEFORE querying profiles or auth.users to avoid timing/existence oracles
      const loginChecks: Array<{ key: string; rule: (typeof RATE_LIMIT_RULES)[keyof typeof RATE_LIMIT_RULES] }> = [
        { key: clientIp, rule: RATE_LIMIT_RULES.loginByIp },
      ];
      if (USERNAME_REGEX.test(normalized)) {
        loginChecks.push(
          { key: `${clientIp}:${normalized}`, rule: RATE_LIMIT_RULES.loginByIpAndUser },
          { key: normalized, rule: RATE_LIMIT_RULES.loginByUser }
        );
      }

      const limit = rateLimiter.consumeAll(loginChecks);
      if (!limit.allowed) {
        return rateLimitedResponse(limit.retryAfterSeconds, corsHeaders);
      }

      if (!USERNAME_REGEX.test(normalized) || !password) {
        return jsonResponse({ error: 'Username atau password tidak sesuai.' }, 401, corsHeaders);
      }

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('id, username')
        .eq('username_normalized', normalized)
        .maybeSingle();

      if (!profile?.id) {
        return jsonResponse({ error: 'Username atau password tidak sesuai.' }, 401, corsHeaders);
      }

      const { data: authUserRes, error: userErr } = await supabaseAdmin.auth.admin.getUserById(
        profile.id
      );
      const authEmail = authUserRes?.user?.email;
      if (userErr || !authEmail) {
        return jsonResponse({ error: 'Username atau password tidak sesuai.' }, 401, corsHeaders);
      }

      const { data: signInData, error: signInErr } = await supabasePublic.auth.signInWithPassword({
        email: authEmail,
        password,
      });

      if (signInErr || !signInData.session || !signInData.user) {
        return jsonResponse({ error: 'Username atau password tidak sesuai.' }, 401, corsHeaders);
      }

      // Return ONLY session tokens + non-PII user summary; never expose recovery_email separately.
      return jsonResponse(
        {
          access_token: signInData.session.access_token,
          refresh_token: signInData.session.refresh_token,
          user: {
            id: signInData.user.id,
            username: profile.username ?? normalized,
          },
        },
        200,
        corsHeaders
      );
    }

    if (action === 'reset_password') {
      const identifier =
        typeof payload?.identifier === 'string' ? payload.identifier.trim().toLowerCase() : '';
      const rawRedirectTo = typeof payload?.redirectTo === 'string' ? payload.redirectTo : '';
      const redirectOrigin = rawRedirectTo ? evaluateCorsOrigin(rawRedirectTo, allowedOrigins) : null;
      const redirectTo =
        redirectOrigin?.allowed && redirectOrigin.matchedOrigin ? rawRedirectTo : undefined;

      // Enforce rate limit BEFORE validating or looking up any user record
      const resetChecks: Array<{ key: string; rule: (typeof RATE_LIMIT_RULES)[keyof typeof RATE_LIMIT_RULES] }> = [
        { key: clientIp, rule: RATE_LIMIT_RULES.resetByIp },
      ];
      if (identifier) {
        resetChecks.push({ key: identifier.slice(0, 64), rule: RATE_LIMIT_RULES.resetByIdentifier });
      }

      const limit = rateLimiter.consumeAll(resetChecks);
      if (!limit.allowed) {
        return rateLimitedResponse(limit.retryAfterSeconds, corsHeaders);
      }

      if (!identifier) {
        return jsonResponse({ error: 'Identifier required' }, 400, corsHeaders);
      }

      if (USERNAME_REGEX.test(identifier)) {
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .eq('username_normalized', identifier)
          .maybeSingle();

        if (profile?.id) {
          const { data: authUserRes } = await supabaseAdmin.auth.admin.getUserById(profile.id);
          const authEmail = authUserRes?.user?.email;
          if (authEmail) {
            await supabasePublic.auth.resetPasswordForEmail(authEmail, { redirectTo });
          }
        }
      }

      // Always return generic OK without confirming username existence or exposing email
      return jsonResponse({ ok: true }, 200, corsHeaders);
    }

    const fallbackLimit = rateLimiter.consumeAll([
      { key: clientIp, rule: RATE_LIMIT_RULES.fallbackByIp },
    ]);
    if (!fallbackLimit.allowed) {
      return rateLimitedResponse(fallbackLimit.retryAfterSeconds, corsHeaders);
    }

    return jsonResponse({ error: 'Unsupported action' }, 400, corsHeaders);
  } catch {
    const catchLimit = rateLimiter.consumeAll([
      { key: clientIp, rule: RATE_LIMIT_RULES.fallbackByIp },
    ]);
    if (!catchLimit.allowed) {
      return rateLimitedResponse(catchLimit.retryAfterSeconds, corsHeaders);
    }
    return jsonResponse({ error: 'Invalid request' }, 400, corsHeaders);
  }
});
