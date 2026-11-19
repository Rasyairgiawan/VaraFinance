import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    // Seed legacy data before account registration
    const legacy = loadLocalState();
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

    // Legacy state migrated to user-scoped key
    const userState = loadLocalState(reg.session.userId);
    expect(userState.transactions).toHaveLength(1);
    expect(userState.transactions[0].description).toBe('Uang saku kuliah');

    // Logout clears session ONLY — financial data stays intact
    await logoutSession();
    expect(getStoredSession()).toBeNull();
    expect(localStorage.getItem(getStorageKeyForUser(reg.session.userId))).not.toBeNull();

    // Wrong password rejected
    await expect(
      loginWithPassword({ username: 'budi_s', password: 'SalahPassword1' })
    ).rejects.toThrow(/salah/i);

    // Correct password restores session and data
    const loggedIn = await loginWithPassword({
      username: 'budi_s',
      password: 'AmanBanget99',
    });
    expect(loggedIn.session.userId).toBe(reg.session.userId);
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

    // 3 wrong PIN attempts trigger temporary cooldown
    const fail1 = await verifyPinCode(reg.session, '111111');
    expect(fail1.success).toBe(false);
    expect(fail1.remainingSeconds).toBe(0);

    const fail2 = await verifyPinCode(reg.session, '222222');
    expect(fail2.success).toBe(false);
    expect(fail2.remainingSeconds).toBe(0);

    const fail3 = await verifyPinCode(reg.session, '333333');
    expect(fail3.success).toBe(false);
    expect(fail3.remainingSeconds).toBeGreaterThanOrEqual(25);
    expect(getPinCooldownSeconds(reg.session.userId)).toBeGreaterThan(0);

    // Even valid PIN is blocked while cooldown is active
    const blocked = await verifyPinCode(reg.session, '908070');
    expect(blocked.success).toBe(false);
    expect(blocked.message).toMatch(/terkunci sementara/i);

    // Forgot PIN with wrong password fails
    await expect(
      resetPinWithPassword(reg.session, {
        password: 'WrongPassword1',
        newPin: '135790',
        confirmPin: '135790',
      })
    ).rejects.toThrow(/Password akun salah/);

    // Forgot PIN with correct password clears cooldown & updates PIN
    await resetPinWithPassword(reg.session, {
      password: 'StrongPass77',
      newPin: '135790',
      confirmPin: '135790',
    });
    expect(getPinCooldownSeconds(reg.session.userId)).toBe(0);

    const okNewPin = await verifyPinCode(reg.session, '135790');
    expect(okNewPin.success).toBe(true);

    // Change PIN with current PIN
    await changePinWithCurrentPin(reg.session, {
      currentPin: '135790',
      newPin: '246801',
      confirmPin: '246801',
    });
    const okChanged = await verifyPinCode(reg.session, '246801');
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

    await updateSecurityPreferences(reg.session, {
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
  });
});
