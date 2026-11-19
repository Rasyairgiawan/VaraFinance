import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialFinanceState } from '../data/initialProfile';
import { isValidUUID } from '../utils/format';
import {
  buildAllowedOriginSet,
  buildCorsHeaders,
  evaluateCorsOrigin,
  extractClientIp,
  IsolateRateLimiter,
  RATE_LIMIT_RULES,
} from '../../supabase/functions/username-auth/security.ts';
import {
  changePinWithCurrentPin,
  getPinCooldownSeconds,
  getStoredSession,
  hasAnyRegisteredLocalUser,
  loginWithPassword,
  logoutSession,
  recoverLocalPasswordWithKey,
  registerAccount,
  resetPinWithPassword,
  updateSecurityPreferences,
  verifyPinCode,
} from './authService';
import {
  getStorageKeyForUser,
  loadLocalState,
  saveLocalState,
} from './financeRepository';

function createMockLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe('authService — Login, Password, 6-Digit PIN & Session Security', () => {
  beforeEach(() => {
    const mockStorage = createMockLocalStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      configurable: true,
    });
  });

  it('enforces unique username, strong password, 6-digit PIN, and never stores plaintext credentials', async () => {
    expect(hasAnyRegisteredLocalUser()).toBe(false);

    // Weak password rejected
    await expect(
      registerAccount({
        username: 'arya_dev',
        password: '123456',
        confirmPassword: '123456',
        pin: '123456',
        confirmPin: '123456',
      })
    ).rejects.toThrow(/Password belum memenuhi standar/);

    // Non-6-digit PIN rejected
    await expect(
      registerAccount({
        username: 'arya_dev',
        password: 'Password123',
        confirmPassword: 'Password123',
        pin: '1234',
        confirmPin: '1234',
      })
    ).rejects.toThrow(/6 digit/);

    // Valid registration
    const reg = await registerAccount({
      username: 'Arya_Dev',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '482910',
      confirmPin: '482910',
    });

    expect(reg.user.username).toBe('Arya_Dev');
    expect(reg.user.pinEnabled).toBe(true);
    expect(reg.recoveryKey).toMatch(/^KU-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(hasAnyRegisteredLocalUser()).toBe(true);

    // Duplicate username (case-insensitive) rejected
    await expect(
      registerAccount({
        username: 'arya_dev',
        password: 'AnotherPass99',
        confirmPassword: 'AnotherPass99',
        pin: '654321',
        confirmPin: '654321',
      })
    ).rejects.toThrow(/sudah terdaftar/i);

    // Verify neither plaintext password nor plaintext PIN is stored anywhere in localStorage
    const rawUsers = localStorage.getItem('kendaliuang_auth_users_v1') ?? '';
    expect(rawUsers).not.toContain('Password123');
    expect(rawUsers).not.toContain('482910');
    expect(rawUsers).toContain('pbkdf2_sha256$');
  });

  it('migrates legacy local financial data to first user and preserves all data across logout & login', async () => {
    // Seed genuine legacy pre-UUID data before account registration
    const legacy = createInitialFinanceState();
    legacy.settings.fullName = 'Budi Santoso';
    legacy.transactions.push({
      id: 'tx-legacy-1',
      type: 'income',
      amount: 25000,
      categoryId: 'cat-income-allowance',
      accountId: 'acc-cash',
      date: '2026-11-16',
      description: 'Uang saku kuliah',
      tags: [],
      incomeSource: 'daily_allowance',
      isEssential: false,
      isDiscretionary: false,
      exceededBudget: false,
      createdAt: '2026-11-16T08:00:00Z',
    });
    saveLocalState(legacy);

    const reg = await registerAccount({
      username: 'budi_s',
      password: 'AmanBanget99',
      confirmPassword: 'AmanBanget99',
      pin: '112233',
      confirmPin: '112233',
    });

    // Legacy state migrated to user-scoped key and upgraded to UUIDs
    expect(reg.session).not.toBeNull();
    const userState = loadLocalState(reg.session!.userId);
    expect(userState.schemaVersion).toBe(3);
    expect(userState.transactions).toHaveLength(1);
    expect(userState.transactions[0].description).toBe('Uang saku kuliah');
    expect(isValidUUID(userState.transactions[0].id)).toBe(true);
    expect(isValidUUID(userState.transactions[0].accountId)).toBe(true);
    expect(isValidUUID(userState.transactions[0].categoryId)).toBe(true);

    // Logout clears session ONLY — financial data stays intact
    await logoutSession();
    expect(getStoredSession()).toBeNull();
    expect(localStorage.getItem(getStorageKeyForUser(reg.session!.userId))).not.toBeNull();

    // Wrong password rejected
    await expect(
      loginWithPassword({ username: 'budi_s', password: 'SalahPassword1' })
    ).rejects.toThrow(/salah/i);

    // Correct password restores session and data
    const loggedIn = await loginWithPassword({
      username: 'budi_s',
      password: 'AmanBanget99',
    });
    expect(loggedIn.session.userId).toBe(reg.session!.userId);
    expect(loadLocalState(loggedIn.session.userId).transactions).toHaveLength(1);
  });

  it('enforces 6-digit PIN rate limiting cooldown and supports password-verified Forgot PIN & Change PIN', async () => {
    const reg = await registerAccount({
      username: 'pin_tester',
      password: 'StrongPass77',
      confirmPassword: 'StrongPass77',
      pin: '908070',
      confirmPin: '908070',
    });

    expect(reg.session).not.toBeNull();
    const regSession = reg.session!;

    // 3 wrong PIN attempts trigger temporary cooldown
    const fail1 = await verifyPinCode(regSession, '111111');
    expect(fail1.success).toBe(false);
    expect(fail1.remainingSeconds).toBe(0);

    const fail2 = await verifyPinCode(regSession, '222222');
    expect(fail2.success).toBe(false);
    expect(fail2.remainingSeconds).toBe(0);

    const fail3 = await verifyPinCode(regSession, '333333');
    expect(fail3.success).toBe(false);
    expect(fail3.remainingSeconds).toBeGreaterThanOrEqual(25);
    expect(getPinCooldownSeconds(regSession.userId)).toBeGreaterThan(0);

    // Even valid PIN is blocked while cooldown is active
    const blocked = await verifyPinCode(regSession, '908070');
    expect(blocked.success).toBe(false);
    expect(blocked.message).toMatch(/terkunci sementara/i);

    // Forgot PIN with wrong password fails
    await expect(
      resetPinWithPassword(regSession, {
        password: 'WrongPassword1',
        newPin: '135790',
        confirmPin: '135790',
      })
    ).rejects.toThrow(/Password akun salah/);

    // Forgot PIN with correct password clears cooldown & updates PIN
    await resetPinWithPassword(regSession, {
      password: 'StrongPass77',
      newPin: '135790',
      confirmPin: '135790',
    });
    expect(getPinCooldownSeconds(regSession.userId)).toBe(0);

    const okNewPin = await verifyPinCode(regSession, '135790');
    expect(okNewPin.success).toBe(true);

    // Change PIN with current PIN
    await changePinWithCurrentPin(regSession, {
      currentPin: '135790',
      newPin: '246801',
      confirmPin: '246801',
    });
    const okChanged = await verifyPinCode(regSession, '246801');
    expect(okChanged.success).toBe(true);
  });

  it('recovers forgotten password via Recovery Key without deleting financial data and invalidates sessions on new devices', async () => {
    const reg = await registerAccount({
      username: 'device_user',
      password: 'FirstPassword1',
      confirmPassword: 'FirstPassword1',
      pin: '554433',
      confirmPin: '554433',
    });

    await updateSecurityPreferences(reg.session!, {
      autoLockMinutes: 15,
      requirePinOnReopen: false,
    });

    // Simulate switching to a brand new device (new deviceId)
    localStorage.setItem('kendaliuang_device_id_v1', 'dev-brand-new-phone');
    expect(getStoredSession()).toBeNull(); // New device must authenticate via primary login

    // Wrong recovery key fails
    await expect(
      recoverLocalPasswordWithKey({
        username: 'device_user',
        recoveryKey: 'KU-AAAA-BBBB-CCCC',
        newPassword: 'NewPassword2',
        confirmPassword: 'NewPassword2',
      })
    ).rejects.toThrow(/Kode pemulihan tidak valid/);

    // Correct recovery key resets password and rotates key
    const { newRecoveryKey } = await recoverLocalPasswordWithKey({
      username: 'device_user',
      recoveryKey: reg.recoveryKey!,
      newPassword: 'NewPassword2',
      confirmPassword: 'NewPassword2',
    });
    expect(newRecoveryKey).not.toBe(reg.recoveryKey);

    const relogin = await loginWithPassword({
      username: 'device_user',
      password: 'NewPassword2',
    });
    expect(relogin.session.deviceId).toBe('dev-brand-new-phone');
    expect(relogin.user.autoLockMinutes).toBe(15);
    expect(relogin.user.requirePinOnReopen).toBe(false);
  });
});

describe('username-auth Edge Function Security — CORS Allowlist & Server-Side Rate Limiting', () => {
  it('enforces strict origin allowlist from built-in and env-configured origins and rejects wildcard/untrusted origins', () => {
    const allowed = buildAllowedOriginSet((key) => {
      if (key === 'ALLOWED_ORIGINS') {
        return 'https://app.example.com, https://staging.example.com/, *, invalid-url';
      }
      if (key === 'APP_URL') {
        return 'https://portal.example.com/login';
      }
      return undefined;
    });

    // Built-in workspace/dev origins and Capacitor scheme allowed
    expect(evaluateCorsOrigin('http://localhost:3000', allowed)).toEqual({
      allowed: true,
      matchedOrigin: 'http://localhost:3000',
      hasOriginHeader: true,
    });
    expect(evaluateCorsOrigin('https://localhost', allowed)).toEqual({
      allowed: true,
      matchedOrigin: 'https://localhost',
      hasOriginHeader: true,
    });

    // Env-configured production origins allowed
    expect(evaluateCorsOrigin('https://app.example.com', allowed)).toEqual({
      allowed: true,
      matchedOrigin: 'https://app.example.com',
      hasOriginHeader: true,
    });
    expect(evaluateCorsOrigin('https://portal.example.com', allowed)).toEqual({
      allowed: true,
      matchedOrigin: 'https://portal.example.com',
      hasOriginHeader: true,
    });

    // Untrusted/spoofed origins rejected without reflecting Access-Control-Allow-Origin
    expect(evaluateCorsOrigin('https://evil.example.com', allowed).allowed).toBe(false);
    expect(evaluateCorsOrigin('https://app.example.com.evil.test', allowed).allowed).toBe(false);
    expect(evaluateCorsOrigin('null', allowed).allowed).toBe(false);
    expect(evaluateCorsOrigin('*', allowed).allowed).toBe(false);

    // Non-browser request without Origin header does not emit ACAO header
    const noOriginEval = evaluateCorsOrigin(null, allowed);
    expect(noOriginEval.allowed).toBe(true);
    expect(noOriginEval.matchedOrigin).toBeNull();
    expect(buildCorsHeaders(null)).toEqual({ Vary: 'Origin' });

    // Preflight headers include exact matched origin (never '*') and Vary: Origin
    const preflightHeaders = buildCorsHeaders('https://app.example.com', { isPreflight: true });
    expect(preflightHeaders['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(preflightHeaders['Access-Control-Allow-Origin']).not.toBe('*');
    expect(preflightHeaders['Vary']).toBe('Origin');
    expect(preflightHeaders['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
  });

  it('enforces bounded per-isolate rate limits across check_username, login, and reset_password', () => {
    let now = 1_000_000;
    const limiter = new IsolateRateLimiter({ maxEntries: 50, nowFn: () => now });

    // check_username: 15 requests/min per IP
    for (let i = 0; i < RATE_LIMIT_RULES.checkUsernameByIp.maxRequests; i++) {
      expect(
        limiter.consumeAll([{ key: '203.0.113.10', rule: RATE_LIMIT_RULES.checkUsernameByIp }]).allowed
      ).toBe(true);
    }
    const blockedCheck = limiter.consumeAll([
      { key: '203.0.113.10', rule: RATE_LIMIT_RULES.checkUsernameByIp },
    ]);
    expect(blockedCheck.allowed).toBe(false);
    expect(blockedCheck.retryAfterSeconds).toBeGreaterThan(0);

    // Separate IP is unaffected
    expect(
      limiter.consumeAll([{ key: '203.0.113.11', rule: RATE_LIMIT_RULES.checkUsernameByIp }]).allowed
    ).toBe(true);

    // Window expiry restores quota
    now += RATE_LIMIT_RULES.checkUsernameByIp.windowMs + 1;
    expect(
      limiter.consumeAll([{ key: '203.0.113.10', rule: RATE_LIMIT_RULES.checkUsernameByIp }]).allowed
    ).toBe(true);

    // login: 6 attempts/5 min per IP + username
    for (let i = 0; i < RATE_LIMIT_RULES.loginByIpAndUser.maxRequests; i++) {
      expect(
        limiter.consumeAll([
          { key: '198.51.100.5', rule: RATE_LIMIT_RULES.loginByIp },
          { key: '198.51.100.5:target_user', rule: RATE_LIMIT_RULES.loginByIpAndUser },
          { key: 'target_user', rule: RATE_LIMIT_RULES.loginByUser },
        ]).allowed
      ).toBe(true);
    }
    expect(
      limiter.consumeAll([
        { key: '198.51.100.5', rule: RATE_LIMIT_RULES.loginByIp },
        { key: '198.51.100.5:target_user', rule: RATE_LIMIT_RULES.loginByIpAndUser },
        { key: 'target_user', rule: RATE_LIMIT_RULES.loginByUser },
      ]).allowed
    ).toBe(false);

    // reset_password: 3 attempts per identifier
    for (let i = 0; i < RATE_LIMIT_RULES.resetByIdentifier.maxRequests; i++) {
      expect(
        limiter.consumeAll([
          { key: `192.0.2.${i + 1}`, rule: RATE_LIMIT_RULES.resetByIp },
          { key: 'alice_user', rule: RATE_LIMIT_RULES.resetByIdentifier },
        ]).allowed
      ).toBe(true);
    }
    expect(
      limiter.consumeAll([
        { key: '192.0.2.99', rule: RATE_LIMIT_RULES.resetByIp },
        { key: 'alice_user', rule: RATE_LIMIT_RULES.resetByIdentifier },
      ]).allowed
    ).toBe(false);

    // Bounded memory enforcement
    for (let i = 0; i < 100; i++) {
      limiter.consume(`flood-${i}`, RATE_LIMIT_RULES.checkUsernameByIp);
    }
    expect(limiter.size).toBeLessThanOrEqual(50);

    // Client IP extraction prioritizes edge proxy headers safely
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.42',
      'x-forwarded-for': '198.51.100.9, 10.0.0.1',
    });
    expect(extractClientIp(headers)).toBe('203.0.113.42');
    expect(extractClientIp(new Headers())).toBe('unknown');
  });
});

describe('Cloud Registration — Fail-Closed Username Availability Verification', () => {
  beforeEach(() => {
    vi.resetModules();
    const mockStorage = createMockLocalStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      configurable: true,
    });
  });

  it('fails closed and never calls signUp when Edge Function verification errors, times out, returns 429, or returns invalid payload', async () => {
    const invokeMock = vi.fn();
    const signUpMock = vi.fn();

    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: {
        functions: { invoke: invokeMock },
        auth: { signUp: signUpMock },
        from: vi.fn(),
      },
    }));

    const { registerAccount: registerCloud } = await import('./authService');

    // Case 1: Network / 500 Edge Function error
    invokeMock.mockResolvedValueOnce({
      data: null,
      error: new Error('RelayError: Edge Function unreachable'),
    });
    await expect(
      registerCloud({
        username: 'cloud_user',
        email: 'cloud@example.com',
        password: 'Password123',
        confirmPassword: 'Password123',
        pin: '482910',
        confirmPin: '482910',
      })
    ).rejects.toThrow(/tidak tersedia/i);
    expect(signUpMock).not.toHaveBeenCalled();

    // Case 2: HTTP 429 Rate Limit
    invokeMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Edge Function returned a non-2xx status code', context: { status: 429 } },
    });
    await expect(
      registerCloud({
        username: 'cloud_user',
        email: 'cloud@example.com',
        password: 'Password123',
        confirmPassword: 'Password123',
        pin: '482910',
        confirmPin: '482910',
      })
    ).rejects.toThrow(/Terlalu banyak percobaan/i);
    expect(signUpMock).not.toHaveBeenCalled();

    // Case 3: Malformed payload (missing boolean `available`)
    invokeMock.mockResolvedValueOnce({
      data: { unexpected: true },
      error: null,
    });
    await expect(
      registerCloud({
        username: 'cloud_user',
        email: 'cloud@example.com',
        password: 'Password123',
        confirmPassword: 'Password123',
        pin: '482910',
        confirmPin: '482910',
      })
    ).rejects.toThrow(/tidak dapat dipastikan/i);
    expect(signUpMock).not.toHaveBeenCalled();

    // Case 4: Username unavailable (available: false) — generic non-enumerating message
    invokeMock.mockResolvedValueOnce({
      data: { available: false },
      error: null,
    });
    await expect(
      registerCloud({
        username: 'taken_user',
        email: 'cloud@example.com',
        password: 'Password123',
        confirmPassword: 'Password123',
        pin: '482910',
        confirmPin: '482910',
      })
    ).rejects.toThrow(/Username tidak tersedia/i);
    expect(signUpMock).not.toHaveBeenCalled();

    // Case 5: Verified available (available: true) proceeds cleanly to signUp
    invokeMock.mockResolvedValueOnce({
      data: { available: true },
      error: null,
    });
    signUpMock.mockResolvedValueOnce({
      data: { user: { id: '11111111-1111-4111-8111-111111111111' }, session: null },
      error: null,
    });

    const result = await registerCloud({
      username: 'fresh_user',
      email: 'fresh@example.com',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '482910',
      confirmPin: '482910',
    });
    expect(signUpMock).toHaveBeenCalledTimes(1);
    expect(result.user.mode).toBe('cloud');
    expect(result.requiresEmailVerification).toBe(true);
    expect(result.session).toBeNull();
  });
});

describe('Phase 3.2B — Cloud Auth, Account Linking, Isolation & Session Lifecycle', () => {
  const CLOUD_UUID_A = '11111111-1111-4111-8111-111111111111';
  const CLOUD_UUID_B = '22222222-2222-4222-8222-222222222222';

  function createSupabaseHarness() {
    const profileStore = new Map<string, Record<string, unknown>>();
    let currentSession: {
      access_token: string;
      refresh_token: string;
      expires_at: number;
      user: { id: string; email?: string; user_metadata?: Record<string, unknown> };
    } | null = null;
    let authListener:
      | ((event: string, session: typeof currentSession) => void)
      | null = null;

    const invokeMock = vi.fn();
    const signUpMock = vi.fn();
    const signInWithPasswordMock = vi.fn();
    const setSessionMock = vi.fn(async ({ access_token, refresh_token }) => {
      const userId = access_token.startsWith('tok-b') ? CLOUD_UUID_B : CLOUD_UUID_A;
      const email = userId === CLOUD_UUID_B ? 'userb@example.com' : 'usera@example.com';
      currentSession = {
        access_token,
        refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: {
          id: userId,
          email,
          user_metadata: { username: userId === CLOUD_UUID_B ? 'user_b' : 'user_a' },
        },
      };
      return { data: { user: currentSession.user, session: currentSession }, error: null };
    });
    const getSessionMock = vi.fn(async () => ({ data: { session: currentSession }, error: null }));
    const refreshSessionMock = vi.fn(async () => {
      if (!currentSession) {
        return { data: { session: null }, error: new Error('Refresh token expired') };
      }
      currentSession = {
        ...currentSession,
        expires_at: Math.floor(Date.now() / 1000) + 7200,
      };
      return { data: { session: currentSession }, error: null };
    });
    const signOutMock = vi.fn(async () => {
      currentSession = null;
      return { error: null };
    });
    const resetPasswordForEmailMock = vi.fn(async () => ({ data: {}, error: null }));
    const updateUserMock = vi.fn(async () => ({ data: { user: currentSession?.user ?? null }, error: null }));
    const resendMock = vi.fn(async () => ({ data: {}, error: null }));
    const unsubscribeMock = vi.fn();
    const onAuthStateChangeMock = vi.fn((cb: (event: string, session: typeof currentSession) => void) => {
      authListener = cb;
      return { data: { subscription: { unsubscribe: unsubscribeMock } } };
    });

    const fromMock = vi.fn((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: async () => ({
                data: profileStore.get(val) ?? null,
                error: null,
              }),
            }),
          }),
          upsert: async (payload: Record<string, unknown>) => {
            profileStore.set(String(payload.id), payload);
            return { data: payload, error: null };
          },
          update: (patch: Record<string, unknown>) => ({
            eq: async (_col: string, val: string) => {
              const existing = profileStore.get(val) ?? { id: val };
              profileStore.set(val, { ...existing, ...patch });
              return { data: null, error: null };
            },
          }),
        };
      }
      throw new Error(`Unexpected non-auth table access in Phase 3.2B: ${table}`);
    });

    const client = {
      functions: { invoke: invokeMock },
      auth: {
        signUp: signUpMock,
        signInWithPassword: signInWithPasswordMock,
        setSession: setSessionMock,
        getSession: getSessionMock,
        refreshSession: refreshSessionMock,
        signOut: signOutMock,
        resetPasswordForEmail: resetPasswordForEmailMock,
        updateUser: updateUserMock,
        resend: resendMock,
        onAuthStateChange: onAuthStateChangeMock,
      },
      from: fromMock,
    };

    return {
      client,
      profileStore,
      setCurrentSession: (s: typeof currentSession) => {
        currentSession = s;
      },
      getCurrentSession: () => currentSession,
      emitAuthEvent: (event: string, session: typeof currentSession) => {
        authListener?.(event, session);
      },
      mocks: {
        invokeMock,
        signUpMock,
        signInWithPasswordMock,
        setSessionMock,
        getSessionMock,
        refreshSessionMock,
        signOutMock,
        resetPasswordForEmailMock,
        updateUserMock,
        resendMock,
        fromMock,
      },
    };
  }

  beforeEach(() => {
    vi.resetModules();
    const mockStorage = createMockLocalStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      configurable: true,
    });
  });

  it('1. handles Cloud registration success (with immediate session & verification-pending) and failure cases safely', async () => {
    const harness = createSupabaseHarness();
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: harness.client,
    }));

    const auth = await import('./authService');

    // 1a. Registration requiring email verification does NOT write AUTH_SESSION_KEY or create active session
    harness.mocks.invokeMock.mockResolvedValueOnce({ data: { available: true }, error: null });
    harness.mocks.signUpMock.mockResolvedValueOnce({
      data: {
        user: { id: CLOUD_UUID_A, email: 'alice@example.com', identities: [{ id: 'id-1' }] },
        session: null,
      },
      error: null,
    });

    const pendingReg = await auth.registerAccount({
      username: 'Alice.01',
      email: 'alice@example.com',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '112233',
      confirmPin: '112233',
    });
    expect(pendingReg.requiresEmailVerification).toBe(true);
    expect(pendingReg.session).toBeNull();
    expect(auth.getStoredSession()).toBeNull();

    // 1b. Duplicate obfuscated email (identities: []) rejected cleanly
    harness.mocks.invokeMock.mockResolvedValueOnce({ data: { available: true }, error: null });
    harness.mocks.signUpMock.mockResolvedValueOnce({
      data: {
        user: { id: CLOUD_UUID_A, email: 'alice@example.com', identities: [] },
        session: null,
      },
      error: null,
    });
    await expect(
      auth.registerAccount({
        username: 'Alice.02',
        email: 'alice@example.com',
        password: 'Password123',
        confirmPassword: 'Password123',
        pin: '112233',
        confirmPin: '112233',
      })
    ).rejects.toThrow(/sudah terdaftar/i);

    // 1c. Registration with immediate session inserts public.profiles and sets active cloud session
    harness.mocks.invokeMock.mockResolvedValueOnce({ data: { available: true }, error: null });
    harness.mocks.signUpMock.mockResolvedValueOnce({
      data: {
        user: { id: CLOUD_UUID_B, email: 'bob@example.com', identities: [{ id: 'id-2' }] },
        session: {
          access_token: 'tok-b',
          refresh_token: 'ref-b',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    });

    const immediateReg = await auth.registerAccount({
      username: 'Bob_Fin',
      email: 'bob@example.com',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '654321',
      confirmPin: '654321',
    });
    expect(immediateReg.requiresEmailVerification).toBe(false);
    expect(immediateReg.session?.userId).toBe(CLOUD_UUID_B);
    expect(harness.profileStore.get(CLOUD_UUID_B)?.username).toBe('Bob_Fin');
    expect(auth.getStoredSession()?.userId).toBe(CLOUD_UUID_B);
  });

  it('2. handles Cloud login success (username & email) and failures (invalid credentials, 429 rate-limit)', async () => {
    const harness = createSupabaseHarness();
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: harness.client,
    }));

    const auth = await import('./authService');

    // Username login success via Edge Function
    harness.mocks.invokeMock.mockResolvedValueOnce({
      data: {
        access_token: 'tok-a',
        refresh_token: 'ref-a',
        user: { id: CLOUD_UUID_A, username: 'user_a' },
      },
      error: null,
    });
    const okUsername = await auth.loginWithPassword({
      username: 'user_a',
      password: 'Password123',
    });
    expect(okUsername.session.mode).toBe('cloud');
    expect(okUsername.session.userId).toBe(CLOUD_UUID_A);

    // Email login success
    harness.mocks.signInWithPasswordMock.mockResolvedValueOnce({
      data: {
        user: {
          id: CLOUD_UUID_B,
          email: 'userb@example.com',
          user_metadata: { username: 'user_b' },
        },
        session: {
          access_token: 'tok-b',
          refresh_token: 'ref-b',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    });
    const okEmail = await auth.loginWithPassword({
      username: 'userb@example.com',
      password: 'Password123',
    });
    expect(okEmail.session.userId).toBe(CLOUD_UUID_B);

    // Invalid credentials (401)
    harness.mocks.invokeMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invalid credentials', context: { status: 401 } },
    });
    await expect(
      auth.loginWithPassword({ username: 'user_a', password: 'WrongPassword1' })
    ).rejects.toThrow(/tidak sesuai/i);

    // Server-side 429 rate-limit
    harness.mocks.invokeMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Too many requests', context: { status: 429 } },
    });
    await expect(
      auth.loginWithPassword({ username: 'user_a', password: 'Password123' })
    ).rejects.toThrow(/Terlalu banyak percobaan/i);
  });

  it('3 & 4. links local account to Cloud preserving all local FinanceState and behaves idempotently on repeated linking', async () => {
    const harness = createSupabaseHarness();
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: harness.client,
    }));

    const auth = await import('./authService');
    const repo = await import('./financeRepository');

    // Create local account offline-first and add real local transaction
    const localReg = await auth.registerAccount({
      username: 'local_owner',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '112233',
      confirmPin: '112233',
      mode: 'local',
    });
    const localUserId = localReg.session!.userId;
    expect(localUserId.startsWith('usr-')).toBe(true);

    const beforeState = repo.loadLocalState(localUserId);
    beforeState.transactions.push({
      id: '33333333-3333-4333-8333-333333333333',
      type: 'expense',
      amount: 45000,
      categoryId: beforeState.categories[0].id,
      accountId: beforeState.accounts[0].id,
      date: '2026-11-18',
      description: 'Makan siang lokal',
      tags: [],
      isEssential: true,
      isDiscretionary: false,
      exceededBudget: false,
      createdAt: '2026-11-18T12:00:00Z',
    });
    repo.saveLocalState(beforeState, localUserId);

    // Link local account to existing cloud account A
    harness.mocks.signInWithPasswordMock.mockResolvedValue({
      data: {
        user: {
          id: CLOUD_UUID_A,
          email: 'usera@example.com',
          user_metadata: { username: 'cloud_owner' },
        },
        session: {
          access_token: 'tok-a',
          refresh_token: 'ref-a',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    });

    const linked1 = await auth.linkLocalAccountToExistingCloud(localReg.session!, {
      identifier: 'usera@example.com',
      password: 'CloudPassword1',
    });
    expect(linked1.alreadyLinked).toBe(false);
    expect(linked1.link.localUserId).toBe(localUserId);
    expect(linked1.link.cloudUserId).toBe(CLOUD_UUID_A);
    // Never substitutes usr-* for cloudUserId
    expect(linked1.session.cloudUserId).toBe(CLOUD_UUID_A);
    expect(linked1.session.userId).toBe(CLOUD_UUID_A);
    // Both cloud and local sessions resolve storageUserId strictly to localUserId
    expect(auth.resolveStorageUserId(linked1.session)).toBe(localUserId);
    expect(repo.loadLocalState(auth.resolveStorageUserId(linked1.session)!).transactions).toHaveLength(1);
    expect(auth.listAccountLinks()).toHaveLength(1);

    // Repeated (idempotent) linking causes zero duplication and zero data loss
    const linked2 = await auth.linkLocalAccountToExistingCloud(localReg.session!, {
      identifier: 'usera@example.com',
      password: 'CloudPassword1',
    });
    expect(linked2.alreadyLinked).toBe(true);
    expect(auth.listAccountLinks()).toHaveLength(1);
    expect(repo.loadLocalState(localUserId).transactions).toHaveLength(1);
    expect(repo.loadLocalState(localUserId).transactions[0].description).toBe('Makan siang lokal');
  });

  it('5. failed linking (wrong credentials, network failure, conflict) keeps local session & FinanceState untouched', async () => {
    const harness = createSupabaseHarness();
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: harness.client,
    }));

    const auth = await import('./authService');
    const repo = await import('./financeRepository');

    const localReg = await auth.registerAccount({
      username: 'safe_local',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '112233',
      confirmPin: '112233',
      mode: 'local',
    });
    const localId = localReg.session!.userId;
    const initialState = repo.loadLocalState(localId);
    initialState.settings.fullName = 'Owner Safe';
    repo.saveLocalState(initialState, localId);

    // 5a. Wrong cloud password
    harness.mocks.signInWithPasswordMock.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: new Error('Invalid login credentials'),
    });
    await expect(
      auth.linkLocalAccountToExistingCloud(localReg.session!, {
        identifier: 'usera@example.com',
        password: 'WrongPassword1',
      })
    ).rejects.toThrow(/tidak sesuai/i);
    expect(auth.getStoredSession()?.mode).toBe('local');
    expect(auth.getStoredSession()?.userId).toBe(localId);
    expect(auth.listAccountLinks()).toHaveLength(0);
    expect(repo.loadLocalState(localId).settings.fullName).toBe('Owner Safe');

    // 5b. Cloud account already has separate meaningful local FinanceState -> LINK_CONFLICT + signOut rollback
    const cloudSeparateState = repo.loadLocalState(CLOUD_UUID_B);
    cloudSeparateState.transactions.push({
      id: '44444444-4444-4444-8444-444444444444',
      type: 'income',
      amount: 100000,
      categoryId: cloudSeparateState.categories[0].id,
      accountId: cloudSeparateState.accounts[0].id,
      date: '2026-11-18',
      description: 'Transaksi terpisah di B',
      tags: [],
      isEssential: false,
      isDiscretionary: false,
      exceededBudget: false,
      createdAt: '2026-11-18T12:00:00Z',
    });
    repo.saveLocalState(cloudSeparateState, CLOUD_UUID_B);

    harness.mocks.signInWithPasswordMock.mockResolvedValueOnce({
      data: {
        user: { id: CLOUD_UUID_B, email: 'userb@example.com' },
        session: {
          access_token: 'tok-b',
          refresh_token: 'ref-b',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    });

    await expect(
      auth.linkLocalAccountToExistingCloud(localReg.session!, {
        identifier: 'userb@example.com',
        password: 'Password123',
      })
    ).rejects.toThrow(/sudah memiliki data keuangan lokal terpisah/i);
    expect(harness.mocks.signOutMock).toHaveBeenCalled();
    expect(auth.getStoredSession()?.mode).toBe('local');
    expect(auth.getStoredSession()?.userId).toBe(localId);
    expect(auth.listAccountLinks()).toHaveLength(0);
  });

  it('6. local account (both unlinked & linked) can still log in offline when cloud is unavailable', async () => {
    const harness = createSupabaseHarness();
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: harness.client,
    }));

    const auth = await import('./authService');
    const repo = await import('./financeRepository');

    const localReg = await auth.registerAccount({
      username: 'offline_hero',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '112233',
      confirmPin: '112233',
      mode: 'local',
    });
    const localId = localReg.session!.userId;

    // Link it first
    harness.mocks.signInWithPasswordMock.mockResolvedValueOnce({
      data: {
        user: { id: CLOUD_UUID_A, email: 'usera@example.com' },
        session: {
          access_token: 'tok-a',
          refresh_token: 'ref-a',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    });
    await auth.linkLocalAccountToExistingCloud(localReg.session!, {
      identifier: 'usera@example.com',
      password: 'Password123',
    });

    const state = repo.loadLocalState(localId);
    state.settings.fullName = 'Offline Verified';
    repo.saveLocalState(state, localId);
    await auth.logoutSession();

    // Simulate Edge Function completely offline (FunctionsFetchError)
    const fetchErr = new Error('Failed to send a request to the Edge Function');
    fetchErr.name = 'FunctionsFetchError';
    harness.mocks.invokeMock.mockRejectedValueOnce(fetchErr);

    const offlineLogin = await auth.loginWithPassword({
      username: 'offline_hero',
      password: 'Password123',
    });
    expect(offlineLogin.session.mode).toBe('local');
    expect(offlineLogin.session.userId).toBe(localId);
    expect(auth.resolveStorageUserId(offlineLogin.session)).toBe(localId);
    expect(repo.loadLocalState(localId).settings.fullName).toBe('Offline Verified');

    // Also test explicit preferredMode: 'local'
    await auth.logoutSession();
    const explicitLocal = await auth.loginWithPassword({
      username: 'offline_hero',
      password: 'Password123',
      preferredMode: 'local',
    });
    expect(explicitLocal.session.mode).toBe('local');
    expect(explicitLocal.user.isLinked).toBe(true);
  });

  it('7. cloud logout clears session without deleting FinanceState, link registry, or backups', async () => {
    const harness = createSupabaseHarness();
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: harness.client,
    }));

    const auth = await import('./authService');
    const repo = await import('./financeRepository');

    harness.mocks.invokeMock.mockResolvedValueOnce({ data: { available: true }, error: null });
    harness.mocks.signUpMock.mockResolvedValueOnce({
      data: {
        user: { id: CLOUD_UUID_A, email: 'alice@example.com', identities: [{ id: '1' }] },
        session: {
          access_token: 'tok-a',
          refresh_token: 'ref-a',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    });

    const reg = await auth.registerAccount({
      username: 'cloud_alice',
      email: 'alice@example.com',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '112233',
      confirmPin: '112233',
    });
    const uid = reg.session!.userId;
    const saved = repo.loadLocalState(uid);
    saved.settings.fullName = 'Alice Persisted';
    repo.saveLocalState(saved, uid);

    await auth.logoutSession();
    expect(harness.mocks.signOutMock).toHaveBeenCalledTimes(1);
    expect(auth.getStoredSession()).toBeNull();
    expect(repo.loadLocalState(uid).settings.fullName).toBe('Alice Persisted');
  });

  it('8. enforces strict isolation so User A cannot access User B identity, links, or FinanceState', async () => {
    const harness = createSupabaseHarness();
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: harness.client,
    }));

    const auth = await import('./authService');
    const repo = await import('./financeRepository');

    // User A local + linked to CLOUD_UUID_A
    const userA = await auth.registerAccount({
      username: 'user_alpha',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '112233',
      confirmPin: '112233',
      mode: 'local',
    });
    const stateA = repo.loadLocalState(userA.session!.userId);
    stateA.settings.fullName = 'Alpha Private';
    repo.saveLocalState(stateA, userA.session!.userId);

    harness.mocks.signInWithPasswordMock.mockResolvedValueOnce({
      data: {
        user: { id: CLOUD_UUID_A, email: 'usera@example.com' },
        session: {
          access_token: 'tok-a',
          refresh_token: 'ref-a',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    });
    await auth.linkLocalAccountToExistingCloud(userA.session!, {
      identifier: 'usera@example.com',
      password: 'Password123',
    });

    // User B registers separately offline
    const userB = await auth.registerAccount({
      username: 'user_beta',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '654321',
      confirmPin: '654321',
      mode: 'local',
    });
    expect(auth.resolveStorageUserId(userB.session)).toBe(userB.session!.userId);
    expect(auth.resolveStorageUserId(userB.session)).not.toBe(userA.session!.userId);
    expect(repo.loadLocalState(userB.session!.userId).settings.fullName).not.toBe('Alpha Private');

    // User B cannot link to CLOUD_UUID_A because CLOUD_UUID_A is already bound to User A
    harness.mocks.signInWithPasswordMock.mockResolvedValueOnce({
      data: {
        user: { id: CLOUD_UUID_A, email: 'usera@example.com' },
        session: {
          access_token: 'tok-a',
          refresh_token: 'ref-a',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    });
    await expect(
      auth.linkLocalAccountToExistingCloud(userB.session!, {
        identifier: 'usera@example.com',
        password: 'Password123',
      })
    ).rejects.toThrow(/sudah tertaut ke akun lokal lain/i);

    // Tampered cloud session using usr-* ID instead of Supabase UUID is rejected by getStoredSession()
    localStorage.setItem(
      'kendaliuang_auth_session_v1',
      JSON.stringify({
        userId: userA.session!.userId,
        mode: 'cloud',
        deviceId: repo.getOrCreateDeviceId(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        issuedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        username: 'attacker',
      })
    );
    expect(auth.getStoredSession()).toBeNull();
  });

  it('9. handles unverified email errors consistently on login and supports resending verification', async () => {
    const harness = createSupabaseHarness();
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: harness.client,
    }));

    const auth = await import('./authService');

    // 9a. Username login returning 403 EMAIL_NOT_CONFIRMED
    harness.mocks.invokeMock.mockResolvedValueOnce({
      data: { code: 'EMAIL_NOT_CONFIRMED', error: 'Email not confirmed' },
      error: { message: 'Edge Function error', context: { status: 403 } },
    });
    await expect(
      auth.loginWithPassword({ username: 'unverified_user', password: 'Password123' })
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_CONFIRMED' });

    // 9b. Email login returning GoTrue "Email not confirmed"
    harness.mocks.signInWithPasswordMock.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: 'Email not confirmed', code: 'email_not_confirmed' },
    });
    await expect(
      auth.loginWithPassword({ username: 'unverified@example.com', password: 'Password123' })
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_CONFIRMED' });

    // 9c. Resend verification email
    await auth.resendCloudVerificationEmail('unverified@example.com');
    expect(harness.mocks.resendMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'signup', email: 'unverified@example.com' })
    );
  });

  it('10. handles Cloud password reset request and recovery password completion', async () => {
    const harness = createSupabaseHarness();
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: harness.client,
    }));

    const auth = await import('./authService');

    // Username reset request calls Edge Function action: reset_password
    harness.mocks.invokeMock.mockResolvedValueOnce({ data: { ok: true }, error: null });
    await auth.requestCloudPasswordReset('User_A');
    expect(harness.mocks.invokeMock).toHaveBeenCalledWith(
      'username-auth',
      expect.objectContaining({
        body: expect.objectContaining({ action: 'reset_password', identifier: 'user_a' }),
      })
    );

    // Email reset request calls Supabase resetPasswordForEmail
    await auth.requestCloudPasswordReset('usera@example.com');
    expect(harness.mocks.resetPasswordForEmailMock).toHaveBeenCalledWith(
      'usera@example.com',
      expect.any(Object)
    );

    // Recovery completion validates password strength and updates user
    await expect(auth.completeCloudPasswordReset('weak', 'weak')).rejects.toThrow(
      /standar keamanan/i
    );
    await auth.completeCloudPasswordReset('NewStrongPass1', 'NewStrongPass1');
    expect(harness.mocks.updateUserMock).toHaveBeenCalledWith({ password: 'NewStrongPass1' });
  });

  it('11. refreshes expiring cloud sessions, clears expired sessions on refresh failure, and never hijacks local sessions', async () => {
    const harness = createSupabaseHarness();
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: harness.client,
    }));

    const auth = await import('./authService');

    // Setup expiring cloud session (expires in 10 seconds -> triggers proactive refreshSession)
    harness.setCurrentSession({
      access_token: 'tok-expiring',
      refresh_token: 'ref-a',
      expires_at: Math.floor(Date.now() / 1000) + 10,
      user: {
        id: CLOUD_UUID_A,
        email: 'usera@example.com',
        user_metadata: { username: 'user_a' },
      },
    });

    const refreshed = await auth.resolveValidSession();
    expect(harness.mocks.refreshSessionMock).toHaveBeenCalledTimes(1);
    expect(refreshed?.userId).toBe(CLOUD_UUID_A);
    expect(Date.parse(refreshed!.expiresAt)).toBeGreaterThan(Date.now() + 3600 * 1000);

    // If refresh fails, clears cloud session cleanly
    harness.setCurrentSession({
      access_token: 'tok-expired',
      refresh_token: 'ref-bad',
      expires_at: Math.floor(Date.now() / 1000) - 60,
      user: { id: CLOUD_UUID_A, email: 'usera@example.com' },
    });
    harness.mocks.refreshSessionMock.mockResolvedValueOnce({
      data: { session: null },
      error: new Error('Invalid refresh token'),
    });
    const expiredResolved = await auth.resolveValidSession();
    expect(expiredResolved).toBeNull();
    expect(auth.getStoredSession()).toBeNull();

    // Active local session is NEVER overwritten even if Supabase holds a cloud session
    const localReg = await auth.registerAccount({
      username: 'local_priority',
      password: 'Password123',
      confirmPassword: 'Password123',
      pin: '112233',
      confirmPin: '112233',
      mode: 'local',
    });
    harness.setCurrentSession({
      access_token: 'tok-b',
      refresh_token: 'ref-b',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: CLOUD_UUID_B, email: 'userb@example.com' },
    });
    const resolvedWhileLocal = await auth.resolveValidSession();
    expect(resolvedWhileLocal?.mode).toBe('local');
    expect(resolvedWhileLocal?.userId).toBe(localReg.session!.userId);

    // Auth state listener propagates PASSWORD_RECOVERY & TOKEN_REFRESHED / SIGNED_OUT
    const onRecovered = vi.fn();
    const onRefreshed = vi.fn();
    const onSignedOut = vi.fn();
    const unsub = auth.subscribeCloudAuthChanges({
      onPasswordRecovery: onRecovered,
      onTokenRefreshed: onRefreshed,
      onSignedOut,
    });
    harness.emitAuthEvent('PASSWORD_RECOVERY', null);
    expect(onRecovered).toHaveBeenCalledTimes(1);

    // Switch local session off so TOKEN_REFRESHED / SIGNED_OUT apply to cloud session
    await auth.logoutSession();
    harness.emitAuthEvent('TOKEN_REFRESHED', {
      access_token: 'tok-b2',
      refresh_token: 'ref-b2',
      expires_at: Math.floor(Date.now() / 1000) + 5000,
      user: { id: CLOUD_UUID_B, email: 'userb@example.com', user_metadata: { username: 'user_b' } },
    });
    expect(onRefreshed).toHaveBeenCalledTimes(1);
    harness.emitAuthEvent('SIGNED_OUT', null);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('12. enforces identical username normalization and regex validation across frontend, Edge Function, and SQL', async () => {
    const auth = await import('./authService');
    const edgeUsernameRegex = /^[a-z0-9._]{3,24}$/;
    const sqlUsernameRegex = /^[A-Za-z0-9._]{3,24}$/;

    const validSamples = ['Arya_01', 'budi.santoso', 'u_1', 'A'.repeat(24)];
    const invalidSamples = [
      'ab',
      'a'.repeat(25),
      'user-name', // Hyphen must be rejected across ALL layers
      'user name',
      'user@mail',
      'user!',
    ];

    for (const sample of validSamples) {
      expect(auth.validateUsername(sample)).toBeNull();
      expect(auth.USERNAME_VALIDATION_REGEX.test(sample)).toBe(true);
      expect(sqlUsernameRegex.test(sample)).toBe(true);
      expect(edgeUsernameRegex.test(auth.normalizeUsername(sample))).toBe(true);
    }

    for (const bad of invalidSamples) {
      expect(auth.validateUsername(bad)).not.toBeNull();
      expect(auth.USERNAME_VALIDATION_REGEX.test(bad.trim())).toBe(false);
      expect(sqlUsernameRegex.test(bad.trim())).toBe(false);
      expect(edgeUsernameRegex.test(auth.normalizeUsername(bad))).toBe(false);
    }

    expect(auth.normalizeUsername('  Budi.S_1  ')).toBe('budi.s_1');
  });

  it('13. ensures full-table FinanceState cloud sync remains disabled in useFinanceStore', async () => {
    const harness = createSupabaseHarness();
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      supabase: harness.client,
    }));

    const fs = await import('node:fs');
    const storeSource = fs.readFileSync('src/hooks/useFinanceStore.ts', 'utf8');
    expect(storeSource).not.toContain('pullFromSupabase');
    expect(storeSource).not.toContain('pushStateToSupabase');
    expect(harness.mocks.fromMock).not.toHaveBeenCalled();
  });
});

