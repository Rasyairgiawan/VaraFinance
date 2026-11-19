import { isSupabaseConfigured, supabase } from '../lib/supabase';
import {
  AuthProviderMode,
  AuthSession,
  AuthUserSummary,
  PinGuardState,
  SecurityPreferences,
} from '../types/finance';
import { generateId } from '../utils/format';
import {
  getOrCreateDeviceId,
  loadLocalState,
  migrateLegacyLocalStateToUser,
  saveLocalState,
} from './financeRepository';

const AUTH_USERS_KEY = 'kendaliuang_auth_users_v1';
const AUTH_SESSION_KEY = 'kendaliuang_auth_session_v1';
const PIN_GUARD_PREFIX = 'kendaliuang_pin_guard_v1_';
const LOGIN_GUARD_KEY = 'kendaliuang_login_guard_v1';

const PASSWORD_PBKDF2_ITERATIONS = 120_000;
const PIN_PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface StoredLocalAuthUser {
  userId: string;
  username: string; // normalized lowercase
  usernameDisplay: string;
  email?: string;
  passwordHash: string;
  recoveryKeyHash: string;
  pinHash: string | null;
  pinEnabled: boolean;
  requirePinOnReopen: boolean;
  autoLockMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterInput {
  username: string;
  email?: string;
  password: string;
  confirmPassword: string;
  pin: string;
  confirmPin: string;
}

export interface RegisterResult {
  session: AuthSession;
  user: AuthUserSummary;
  recoveryKey: string | null; // Shown once in local mode for offline password recovery
  requiresEmailVerification?: boolean;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface PinVerificationResult {
  success: boolean;
  message?: string;
  guard: PinGuardState;
  remainingSeconds: number;
}

export interface PasswordStrengthReport {
  valid: boolean;
  score: 0 | 1 | 2 | 3;
  label: 'Terlalu pendek' | 'Lemah' | 'Sedang' | 'Kuat';
  errors: string[];
}

function getSubtleCrypto(): SubtleCrypto | null {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle;
  }
  return null;
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function hashSecretPBKDF2(
  secret: string,
  iterations: number = PASSWORD_PBKDF2_ITERATIONS,
  saltBytes?: Uint8Array
): Promise<string> {
  const normalized = secret.trim();
  const salt = saltBytes ?? getRandomBytes(16);
  const subtle = getSubtleCrypto();

  if (subtle) {
    const keyMaterial = await subtle.importKey(
      'raw',
      new TextEncoder().encode(normalized),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const bits = await subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt.buffer as ArrayBuffer,
        iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );
    const derivedHex = bytesToHex(new Uint8Array(bits));
    return `pbkdf2_sha256$${iterations}$${bytesToHex(salt)}$${derivedHex}`;
  }

  // Fallback only if SubtleCrypto is completely unavailable in environment
  const fallbackInput = `${bytesToHex(salt)}:${normalized}`;
  let h = 2166136261;
  for (let i = 0; i < fallbackInput.length; i++) {
    h ^= fallbackInput.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a_fallback$1$${bytesToHex(salt)}$${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export async function verifySecretPBKDF2(secret: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;

  if (storedHash.startsWith('pbkdf2_sha256$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) return false;
    const iterations = Number(parts[1]);
    const saltHex = parts[2];
    if (!Number.isFinite(iterations) || iterations < 1000 || !saltHex) return false;
    const recomputed = await hashSecretPBKDF2(secret, iterations, hexToBytes(saltHex));
    return constantTimeEqual(recomputed, storedHash);
  }

  if (storedHash.startsWith('fnv1a_fallback$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) return false;
    const recomputed = await hashSecretPBKDF2(secret, 1, hexToBytes(parts[2]));
    return constantTimeEqual(recomputed, storedHash);
  }

  // Legacy unsalted SHA-256 PIN migration check (64 hex chars)
  if (/^[a-f0-9]{64}$/i.test(storedHash)) {
    const subtle = getSubtleCrypto();
    if (!subtle) return false;
    const data = new TextEncoder().encode(`kendaliuang:${secret.trim()}`);
    const digest = await subtle.digest('SHA-256', data);
    const legacyHex = bytesToHex(new Uint8Array(digest));
    return constantTimeEqual(legacyHex, storedHash);
  }

  return false;
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateUsername(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 3) return 'Username minimal 3 karakter.';
  if (trimmed.length > 24) return 'Username maksimal 24 karakter.';
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return 'Username hanya boleh berisi huruf, angka, titik (.), garis bawah (_), atau tanda hubung (-).';
  }
  return null;
}

export function evaluatePasswordStrength(password: string): PasswordStrengthReport {
  const errors: string[] = [];
  if (password.length < 8) {
    errors.push('Minimal 8 karakter.');
  }
  if (!/[A-Za-z]/.test(password)) {
    errors.push('Harus mengandung minimal 1 huruf.');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Harus mengandung minimal 1 angka.');
  }

  if (password.length < 8) {
    return { valid: false, score: 0, label: 'Terlalu pendek', errors };
  }

  let complexity = 0;
  if (/[a-z]/.test(password)) complexity++;
  if (/[A-Z]/.test(password)) complexity++;
  if (/[0-9]/.test(password)) complexity++;
  if (/[^A-Za-z0-9]/.test(password)) complexity++;
  if (password.length >= 12) complexity++;

  const valid = errors.length === 0;
  if (!valid || complexity <= 2) {
    return { valid, score: 1, label: 'Lemah', errors };
  }
  if (complexity <= 3) {
    return { valid, score: 2, label: 'Sedang', errors };
  }
  return { valid, score: 3, label: 'Kuat', errors };
}

export function validateSixDigitPin(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) {
    return 'PIN harus terdiri dari tepat 6 digit angka.';
  }
  return null;
}

export function generateRecoveryKey(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = getRandomBytes(12);
  let raw = '';
  for (let i = 0; i < 12; i++) {
    raw += alphabet[bytes[i] % alphabet.length];
  }
  return `KU-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function readLocalUsers(): StoredLocalAuthUser[] {
  try {
    const raw = localStorage.getItem(AUTH_USERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalUsers(users: StoredLocalAuthUser[]): void {
  localStorage.setItem(AUTH_USERS_KEY, JSON.stringify(users));
}

function toUserSummary(u: StoredLocalAuthUser, mode: AuthProviderMode): AuthUserSummary {
  return {
    userId: u.userId,
    username: u.usernameDisplay || u.username,
    email: u.email,
    mode,
    pinConfigured: Boolean(u.pinHash),
    pinEnabled: u.pinEnabled && Boolean(u.pinHash),
    requirePinOnReopen: u.requirePinOnReopen,
    autoLockMinutes: u.autoLockMinutes,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function hasAnyRegisteredLocalUser(): boolean {
  return readLocalUsers().length > 0;
}

export function listRegisteredLocalUsernames(): string[] {
  return readLocalUsers().map((u) => u.usernameDisplay || u.username);
}

export function getPinGuard(userId: string): PinGuardState {
  try {
    const raw = localStorage.getItem(`${PIN_GUARD_PREFIX}${userId}`);
    if (!raw) return { failedAttempts: 0, lockedUntil: null };
    const parsed = JSON.parse(raw) as PinGuardState;
    return {
      failedAttempts: typeof parsed.failedAttempts === 'number' ? parsed.failedAttempts : 0,
      lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : null,
    };
  } catch {
    return { failedAttempts: 0, lockedUntil: null };
  }
}

function savePinGuard(userId: string, guard: PinGuardState): void {
  localStorage.setItem(`${PIN_GUARD_PREFIX}${userId}`, JSON.stringify(guard));
}

export function clearPinGuard(userId: string): void {
  localStorage.removeItem(`${PIN_GUARD_PREFIX}${userId}`);
}

export function getPinCooldownSeconds(userId: string, nowMs: number = Date.now()): number {
  const guard = getPinGuard(userId);
  if (!guard.lockedUntil || guard.lockedUntil <= nowMs) return 0;
  return Math.ceil((guard.lockedUntil - nowMs) / 1000);
}

function getLoginGuard(): PinGuardState {
  try {
    const raw = localStorage.getItem(LOGIN_GUARD_KEY);
    if (!raw) return { failedAttempts: 0, lockedUntil: null };
    const parsed = JSON.parse(raw) as PinGuardState;
    return {
      failedAttempts: typeof parsed.failedAttempts === 'number' ? parsed.failedAttempts : 0,
      lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : null,
    };
  } catch {
    return { failedAttempts: 0, lockedUntil: null };
  }
}

function saveLoginGuard(guard: PinGuardState): void {
  localStorage.setItem(LOGIN_GUARD_KEY, JSON.stringify(guard));
}

function clearLoginGuard(): void {
  localStorage.removeItem(LOGIN_GUARD_KEY);
}

function createSessionRecord(params: {
  userId: string;
  username: string;
  email?: string;
  mode: AuthProviderMode;
}): AuthSession {
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  const session: AuthSession = {
    userId: params.userId,
    username: params.username,
    email: params.email,
    mode: params.mode,
    deviceId: getOrCreateDeviceId(),
    issuedAt: now.toISOString(),
    lastActiveAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
  return session;
}

export function getStoredSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed.userId || !parsed.deviceId || !parsed.expiresAt) return null;

    // Enforce device binding: a different deviceId requires primary login
    if (parsed.deviceId !== getOrCreateDeviceId()) {
      return null;
    }

    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      localStorage.removeItem(AUTH_SESSION_KEY);
      return null;
    }

    // In local mode, ensure the user record actually exists
    if (parsed.mode === 'local') {
      const users = readLocalUsers();
      const exists = users.some((u) => u.userId === parsed.userId);
      if (!exists) {
        localStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }
    }

    return parsed;
  } catch {
    return null;
  }
}

export function touchSessionActivity(): AuthSession | null {
  const current = getStoredSession();
  if (!current) return null;
  const now = new Date();
  const updated: AuthSession = {
    ...current,
    lastActiveAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  };
  try {
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(updated));
  } catch {
    // ignore storage quota errors
  }
  return updated;
}

export function getUserSummaryForSession(session: AuthSession | null): AuthUserSummary | null {
  if (!session) return null;
  if (session.mode === 'local') {
    const u = readLocalUsers().find((x) => x.userId === session.userId);
    return u ? toUserSummary(u, 'local') : null;
  }
  const state = loadLocalState(session.userId);
  return {
    userId: session.userId,
    username: state.settings.username || session.username,
    email: session.email,
    mode: 'cloud',
    pinConfigured: Boolean(state.settings.securityPinHash),
    pinEnabled: Boolean(state.settings.pinEnabled && state.settings.securityPinHash),
    requirePinOnReopen: state.settings.requirePinOnReopen ?? true,
    autoLockMinutes: state.settings.autoLockMinutes ?? 5,
    createdAt: session.issuedAt,
    updatedAt: session.lastActiveAt,
  };
}

export async function resolveValidSession(): Promise<AuthSession | null> {
  const localSess = getStoredSession();
  if (isSupabaseConfigured && supabase) {
    try {
      const { data } = await supabase.auth.getSession();
      const supaUser = data.session?.user;
      if (supaUser) {
        if (localSess && localSess.userId === supaUser.id && localSess.mode === 'cloud') {
          return localSess;
        }
        const usernameFromMeta =
          (supaUser.user_metadata?.username as string | undefined) ||
          supaUser.email?.split('@')[0] ||
          'pengguna';
        return createSessionRecord({
          userId: supaUser.id,
          username: usernameFromMeta,
          email: supaUser.email ?? undefined,
          mode: 'cloud',
        });
      }
    } catch {
      // If offline while cloud configured, preserve local device-bound session if valid
      if (localSess) return localSess;
    }
  }
  return localSess;
}

export async function registerAccount(input: RegisterInput): Promise<RegisterResult> {
  const usernameErr = validateUsername(input.username);
  if (usernameErr) throw new Error(usernameErr);

  const normalized = normalizeUsername(input.username);
  const displayUsername = input.username.trim();
  const pwdCheck = evaluatePasswordStrength(input.password);
  if (!pwdCheck.valid) {
    throw new Error(`Password belum memenuhi standar keamanan: ${pwdCheck.errors.join(' ')}`);
  }
  if (input.password !== input.confirmPassword) {
    throw new Error('Konfirmasi password tidak cocok.');
  }

  const pinErr = validateSixDigitPin(input.pin);
  if (pinErr) throw new Error(pinErr);
  if (input.pin !== input.confirmPin) {
    throw new Error('Konfirmasi PIN 6 digit tidak cocok.');
  }

  const pinHash = await hashSecretPBKDF2(input.pin, PIN_PBKDF2_ITERATIONS);

  if (isSupabaseConfigured && supabase) {
    const email = input.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Email valid diperlukan untuk pembuatan akun Cloud Supabase & pemulihan password.');
    }

    const { data: availData, error: availErr } = await supabase.functions.invoke('username-auth', {
      body: { action: 'check_username', username: normalized },
    });
    if (availErr) {
      const status =
        typeof (availErr as { context?: { status?: number } }).context?.status === 'number'
          ? (availErr as { context: { status: number } }).context.status
          : undefined;
      if (status === 429) {
        throw new Error(
          'Terlalu banyak percobaan verifikasi username. Silakan coba lagi beberapa saat lagi.'
        );
      }
      throw new Error(
        'Layanan verifikasi username sedang tidak tersedia. Pendaftaran akun cloud tidak dapat dilanjutkan saat ini.'
      );
    }
    if (!availData || typeof availData.available !== 'boolean') {
      throw new Error(
        'Verifikasi ketersediaan username tidak dapat dipastikan. Pendaftaran akun cloud tidak dapat dilanjutkan saat ini.'
      );
    }
    if (availData.available !== true) {
      throw new Error(
        'Username tidak tersedia atau tidak memenuhi syarat. Silakan pilih username lain.'
      );
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password: input.password,
      options: {
        data: { username: displayUsername },
      },
    });
    if (error) throw new Error(error.message);
    if (!data.user) throw new Error('Pendaftaran akun gagal diproses oleh Supabase.');

    const userId = data.user.id;
    migrateLegacyLocalStateToUser(userId);
    const currentState = loadLocalState(userId);
    const updatedState = {
      ...currentState,
      settings: {
        ...currentState.settings,
        fullName:
          currentState.settings.fullName === 'Pengguna VaraFinance' ||
          currentState.settings.fullName === 'Pengguna KendaliUang'
            ? displayUsername
            : currentState.settings.fullName,
        username: displayUsername,
        securityPinHash: pinHash,
        pinEnabled: true,
        requirePinOnReopen: true,
        autoLockMinutes: 5,
      },
    };
    saveLocalState(updatedState, userId);

    if (data.session) {
      await supabase.from('profiles').upsert({
        id: userId,
        full_name: updatedState.settings.fullName,
        username: displayUsername,
        recovery_email: email,
        security_pin_hash: pinHash,
        pin_enabled: true,
        require_pin_on_reopen: true,
        auto_lock_minutes: 5,
      });
    }

    const session = createSessionRecord({
      userId,
      username: displayUsername,
      email,
      mode: 'cloud',
    });

    return {
      session,
      user: {
        userId,
        username: displayUsername,
        email,
        mode: 'cloud',
        pinConfigured: true,
        pinEnabled: true,
        requirePinOnReopen: true,
        autoLockMinutes: 5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      recoveryKey: null,
      requiresEmailVerification: !data.session,
    };
  }

  // Local Offline-First Mode
  const users = readLocalUsers();
  if (users.some((u) => u.username === normalized)) {
    throw new Error(`Username "${displayUsername}" sudah terdaftar. Pilih username lain atau silakan login.`);
  }

  const userId = `usr-${generateId()}`;
  const isFirstLocalUser = users.length === 0;
  if (isFirstLocalUser) {
    migrateLegacyLocalStateToUser(userId);
  }

  const recoveryKey = generateRecoveryKey();
  const [passwordHash, recoveryKeyHash] = await Promise.all([
    hashSecretPBKDF2(input.password, PASSWORD_PBKDF2_ITERATIONS),
    hashSecretPBKDF2(recoveryKey.toUpperCase(), PASSWORD_PBKDF2_ITERATIONS),
  ]);

  const nowISO = new Date().toISOString();
  const newUser: StoredLocalAuthUser = {
    userId,
    username: normalized,
    usernameDisplay: displayUsername,
    email: input.email?.trim() || undefined,
    passwordHash,
    recoveryKeyHash,
    pinHash,
    pinEnabled: true,
    requirePinOnReopen: true,
    autoLockMinutes: 5,
    createdAt: nowISO,
    updatedAt: nowISO,
  };

  writeLocalUsers([...users, newUser]);

  const currentState = loadLocalState(userId);
  saveLocalState(
    {
      ...currentState,
      settings: {
        ...currentState.settings,
        fullName:
          currentState.settings.fullName === 'Pengguna VaraFinance' ||
          currentState.settings.fullName === 'Pengguna KendaliUang'
            ? displayUsername
            : currentState.settings.fullName,
        username: displayUsername,
        securityPinHash: pinHash,
        pinEnabled: true,
        requirePinOnReopen: true,
        autoLockMinutes: 5,
      },
    },
    userId
  );

  const session = createSessionRecord({
    userId,
    username: displayUsername,
    email: newUser.email,
    mode: 'local',
  });

  return {
    session,
    user: toUserSummary(newUser, 'local'),
    recoveryKey,
  };
}

export async function loginWithPassword(input: LoginInput): Promise<{
  session: AuthSession;
  user: AuthUserSummary;
}> {
  const loginGuard = getLoginGuard();
  if (loginGuard.lockedUntil && loginGuard.lockedUntil > Date.now()) {
    const secs = Math.ceil((loginGuard.lockedUntil - Date.now()) / 1000);
    throw new Error(`Terlalu banyak percobaan login gagal. Coba lagi dalam ${secs} detik.`);
  }

  const rawIdentifier = input.username.trim();
  if (!rawIdentifier || !input.password) {
    throw new Error('Username dan password wajib diisi.');
  }

  if (isSupabaseConfigured && supabase) {
    let authUser = null;
    let resolvedUsername: string | undefined;

    if (!rawIdentifier.includes('@')) {
      const { data: fnData, error: fnErr } = await supabase.functions.invoke('username-auth', {
        body: {
          action: 'login',
          username: normalizeUsername(rawIdentifier),
          password: input.password,
        },
      });
      if (fnErr || !fnData?.access_token || !fnData?.refresh_token) {
        const status =
          typeof (fnErr as { context?: { status?: number } } | null)?.context?.status === 'number'
            ? (fnErr as { context: { status: number } }).context.status
            : undefined;
        const nextFails = loginGuard.failedAttempts + 1;
        const lockMs = nextFails >= 8 ? 120_000 : nextFails >= 5 ? 30_000 : 0;
        saveLoginGuard({
          failedAttempts: nextFails,
          lockedUntil: lockMs > 0 ? Date.now() + lockMs : null,
        });
        if (status === 429) {
          throw new Error('Terlalu banyak percobaan login. Silakan coba lagi beberapa saat lagi.');
        }
        throw new Error('Username atau password tidak sesuai.');
      }

      const { data: sessionData, error: setSessionErr } = await supabase.auth.setSession({
        access_token: fnData.access_token,
        refresh_token: fnData.refresh_token,
      });
      if (setSessionErr || !sessionData.user) {
        throw new Error('Gagal membangun sesi autentikasi cloud.');
      }
      authUser = sessionData.user;
      resolvedUsername = fnData.user?.username;
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: rawIdentifier,
        password: input.password,
      });
      if (error || !data.user) {
        const nextFails = loginGuard.failedAttempts + 1;
        const lockMs = nextFails >= 8 ? 120_000 : nextFails >= 5 ? 30_000 : 0;
        saveLoginGuard({
          failedAttempts: nextFails,
          lockedUntil: lockMs > 0 ? Date.now() + lockMs : null,
        });
        throw new Error('Username atau password tidak sesuai.');
      }
      authUser = data.user;
    }

    clearLoginGuard();
    const displayUsername =
      resolvedUsername ||
      (authUser.user_metadata?.username as string | undefined) ||
      (rawIdentifier.includes('@') ? rawIdentifier.split('@')[0] : rawIdentifier);
    const session = createSessionRecord({
      userId: authUser.id,
      username: displayUsername,
      email: authUser.email ?? (rawIdentifier.includes('@') ? rawIdentifier : undefined),
      mode: 'cloud',
    });
    const summary = getUserSummaryForSession(session)!;
    return { session, user: summary };
  }

  // Local Mode
  const normalized = normalizeUsername(rawIdentifier);
  const users = readLocalUsers();
  const matched = users.find((u) => u.username === normalized);
  const ok = matched ? await verifySecretPBKDF2(input.password, matched.passwordHash) : false;

  if (!matched || !ok) {
    const nextFails = loginGuard.failedAttempts + 1;
    const lockMs = nextFails >= 8 ? 120_000 : nextFails >= 5 ? 30_000 : 0;
    saveLoginGuard({
      failedAttempts: nextFails,
      lockedUntil: lockMs > 0 ? Date.now() + lockMs : null,
    });
    throw new Error('Username atau password salah. Periksa kembali kredensial Anda.');
  }

  clearLoginGuard();
  const session = createSessionRecord({
    userId: matched.userId,
    username: matched.usernameDisplay || matched.username,
    email: matched.email,
    mode: 'local',
  });

  return {
    session,
    user: toUserSummary(matched, 'local'),
  };
}

export async function logoutSession(): Promise<void> {
  localStorage.removeItem(AUTH_SESSION_KEY);
  if (isSupabaseConfigured && supabase) {
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore offline signOut errors; local session is already cleared
    }
  }
}

export async function verifyPinCode(session: AuthSession, pin: string): Promise<PinVerificationResult> {
  const now = Date.now();
  const guard = getPinGuard(session.userId);
  if (guard.lockedUntil && guard.lockedUntil > now) {
    const remainingSeconds = Math.ceil((guard.lockedUntil - now) / 1000);
    return {
      success: false,
      message: `PIN terkunci sementara setelah beberapa kali salah. Coba lagi dalam ${remainingSeconds} detik.`,
      guard,
      remainingSeconds,
    };
  }

  const formatErr = validateSixDigitPin(pin);
  if (formatErr) {
    return {
      success: false,
      message: formatErr,
      guard,
      remainingSeconds: 0,
    };
  }

  let storedHash: string | null = null;
  if (session.mode === 'local') {
    const users = readLocalUsers();
    const u = users.find((x) => x.userId === session.userId);
    storedHash = u?.pinHash ?? null;
  } else {
    const localState = loadLocalState(session.userId);
    storedHash = localState.settings.securityPinHash ?? null;
  }

  if (!storedHash) {
    return {
      success: false,
      message: 'PIN belum diatur untuk akun ini.',
      guard,
      remainingSeconds: 0,
    };
  }

  const ok = await verifySecretPBKDF2(pin, storedHash);
  if (ok) {
    clearPinGuard(session.userId);
    // Transparently upgrade legacy SHA-256 hash to PBKDF2 if needed
    if (!storedHash.startsWith('pbkdf2_sha256$')) {
      const upgradedHash = await hashSecretPBKDF2(pin, PIN_PBKDF2_ITERATIONS);
      await persistPinHash(session, upgradedHash, true);
    }
    return {
      success: true,
      guard: { failedAttempts: 0, lockedUntil: null },
      remainingSeconds: 0,
    };
  }

  const nextFailed = guard.failedAttempts + 1;
  let cooldownSec = 0;
  if (nextFailed >= 7) {
    cooldownSec = 300;
  } else if (nextFailed >= 5) {
    cooldownSec = 60;
  } else if (nextFailed >= 3) {
    cooldownSec = 30;
  }

  const nextGuard: PinGuardState = {
    failedAttempts: nextFailed,
    lockedUntil: cooldownSec > 0 ? now + cooldownSec * 1000 : null,
  };
  savePinGuard(session.userId, nextGuard);

  const message =
    cooldownSec > 0
      ? `PIN salah (${nextFailed}x). Akses PIN dijeda sementara selama ${cooldownSec} detik.`
      : `PIN salah. Percobaan gagal ke-${nextFailed} dari 3 sebelum jeda sementara.`;

  return {
    success: false,
    message,
    guard: nextGuard,
    remainingSeconds: cooldownSec,
  };
}

async function persistPinHash(
  session: AuthSession,
  pinHash: string | null,
  pinEnabled: boolean
): Promise<void> {
  const nowISO = new Date().toISOString();
  if (session.mode === 'local') {
    const users = readLocalUsers();
    writeLocalUsers(
      users.map((u) =>
        u.userId === session.userId
          ? { ...u, pinHash, pinEnabled, updatedAt: nowISO }
          : u
      )
    );
  }
  const state = loadLocalState(session.userId);
  saveLocalState(
    {
      ...state,
      settings: {
        ...state.settings,
        securityPinHash: pinHash ?? undefined,
        pinEnabled,
      },
    },
    session.userId
  );
  if (session.mode === 'cloud' && isSupabaseConfigured && supabase) {
    await supabase
      .from('profiles')
      .update({
        security_pin_hash: pinHash,
        pin_enabled: pinEnabled,
      })
      .eq('id', session.userId);
  }
}

export async function verifyAccountPassword(session: AuthSession, password: string): Promise<boolean> {
  if (!password) return false;
  if (session.mode === 'local') {
    const users = readLocalUsers();
    const u = users.find((x) => x.userId === session.userId);
    if (!u) return false;
    return verifySecretPBKDF2(password, u.passwordHash);
  }
  if (isSupabaseConfigured && supabase && session.email) {
    const { error } = await supabase.auth.signInWithPassword({
      email: session.email,
      password,
    });
    return !error;
  }
  return false;
}

export async function changePinWithCurrentPin(
  session: AuthSession,
  params: { currentPin: string; newPin: string; confirmPin: string }
): Promise<void> {
  const currentCheck = await verifyPinCode(session, params.currentPin);
  if (!currentCheck.success) {
    throw new Error(currentCheck.message || 'PIN saat ini tidak sesuai.');
  }
  const newErr = validateSixDigitPin(params.newPin);
  if (newErr) throw new Error(newErr);
  if (params.newPin !== params.confirmPin) {
    throw new Error('Konfirmasi PIN baru tidak cocok.');
  }
  if (params.newPin === params.currentPin) {
    throw new Error('PIN baru harus berbeda dari PIN sebelumnya.');
  }
  const hash = await hashSecretPBKDF2(params.newPin, PIN_PBKDF2_ITERATIONS);
  await persistPinHash(session, hash, true);
}

export async function resetPinWithPassword(
  session: AuthSession,
  params: { password: string; newPin: string; confirmPin: string }
): Promise<void> {
  const pinErr = validateSixDigitPin(params.newPin);
  if (pinErr) throw new Error(pinErr);
  if (params.newPin !== params.confirmPin) {
    throw new Error('Konfirmasi PIN baru tidak cocok.');
  }
  const validPwd = await verifyAccountPassword(session, params.password);
  if (!validPwd) {
    throw new Error('Password akun salah. Verifikasi gagal.');
  }
  clearPinGuard(session.userId);
  const hash = await hashSecretPBKDF2(params.newPin, PIN_PBKDF2_ITERATIONS);
  await persistPinHash(session, hash, true);
}

export async function setOrEnablePinWithPassword(
  session: AuthSession,
  params: { password: string; newPin: string; confirmPin: string }
): Promise<void> {
  await resetPinWithPassword(session, params);
}

export async function updateSecurityPreferences(
  session: AuthSession,
  updates: Partial<SecurityPreferences>
): Promise<AuthUserSummary> {
  const nowISO = new Date().toISOString();
  if (session.mode === 'local') {
    const users = readLocalUsers();
    let updatedUser: StoredLocalAuthUser | null = null;
    const nextUsers = users.map((u) => {
      if (u.userId !== session.userId) return u;
      if (updates.pinEnabled && !u.pinHash) {
        throw new Error('Atur PIN 6 digit terlebih dahulu sebelum mengaktifkan kunci PIN.');
      }
      updatedUser = {
        ...u,
        pinEnabled: updates.pinEnabled ?? u.pinEnabled,
        requirePinOnReopen: updates.requirePinOnReopen ?? u.requirePinOnReopen,
        autoLockMinutes:
          updates.autoLockMinutes !== undefined ? updates.autoLockMinutes : u.autoLockMinutes,
        updatedAt: nowISO,
      };
      return updatedUser;
    });
    writeLocalUsers(nextUsers);
    if (!updatedUser) throw new Error('Akun pengguna tidak ditemukan.');

    const state = loadLocalState(session.userId);
    saveLocalState(
      {
        ...state,
        settings: {
          ...state.settings,
          pinEnabled: (updatedUser as StoredLocalAuthUser).pinEnabled,
          requirePinOnReopen: (updatedUser as StoredLocalAuthUser).requirePinOnReopen,
          autoLockMinutes: (updatedUser as StoredLocalAuthUser).autoLockMinutes,
        },
      },
      session.userId
    );
    return toUserSummary(updatedUser, 'local');
  }

  const state = loadLocalState(session.userId);
  if (updates.pinEnabled && !state.settings.securityPinHash) {
    throw new Error('Atur PIN 6 digit terlebih dahulu sebelum mengaktifkan kunci PIN.');
  }
  const nextSettings = {
    ...state.settings,
    pinEnabled: updates.pinEnabled ?? state.settings.pinEnabled ?? Boolean(state.settings.securityPinHash),
    requirePinOnReopen: updates.requirePinOnReopen ?? state.settings.requirePinOnReopen ?? true,
    autoLockMinutes:
      updates.autoLockMinutes !== undefined
        ? updates.autoLockMinutes
        : state.settings.autoLockMinutes ?? 5,
  };
  saveLocalState({ ...state, settings: nextSettings }, session.userId);

  if (isSupabaseConfigured && supabase) {
    await supabase
      .from('profiles')
      .update({
        pin_enabled: nextSettings.pinEnabled,
        require_pin_on_reopen: nextSettings.requirePinOnReopen,
        auto_lock_minutes: nextSettings.autoLockMinutes,
      })
      .eq('id', session.userId);
  }

  return getUserSummaryForSession(session)!;
}

export async function recoverLocalPasswordWithKey(params: {
  username: string;
  recoveryKey: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<{ newRecoveryKey: string }> {
  const normalized = normalizeUsername(params.username);
  const users = readLocalUsers();
  const target = users.find((u) => u.username === normalized);
  if (!target) {
    throw new Error('Username tidak ditemukan di perangkat ini.');
  }

  const keyValid = await verifySecretPBKDF2(
    params.recoveryKey.trim().toUpperCase(),
    target.recoveryKeyHash
  );
  if (!keyValid) {
    throw new Error('Kode pemulihan tidak valid. Periksa kembali kode pemulihan Anda.');
  }

  const pwdCheck = evaluatePasswordStrength(params.newPassword);
  if (!pwdCheck.valid) {
    throw new Error(`Password baru belum memenuhi syarat: ${pwdCheck.errors.join(' ')}`);
  }
  if (params.newPassword !== params.confirmPassword) {
    throw new Error('Konfirmasi password baru tidak cocok.');
  }

  const newRecoveryKey = generateRecoveryKey();
  const [newPasswordHash, newRecoveryKeyHash] = await Promise.all([
    hashSecretPBKDF2(params.newPassword, PASSWORD_PBKDF2_ITERATIONS),
    hashSecretPBKDF2(newRecoveryKey.toUpperCase(), PASSWORD_PBKDF2_ITERATIONS),
  ]);

  writeLocalUsers(
    users.map((u) =>
      u.userId === target.userId
        ? {
            ...u,
            passwordHash: newPasswordHash,
            recoveryKeyHash: newRecoveryKeyHash,
            updatedAt: new Date().toISOString(),
          }
        : u
    )
  );
  clearLoginGuard();

  return { newRecoveryKey };
}

export async function regenerateLocalRecoveryKey(
  session: AuthSession,
  password: string
): Promise<string> {
  if (session.mode !== 'local') {
    throw new Error('Kode pemulihan lokal hanya digunakan pada mode offline/lokal.');
  }
  const ok = await verifyAccountPassword(session, password);
  if (!ok) {
    throw new Error('Password tidak sesuai.');
  }
  const newRecoveryKey = generateRecoveryKey();
  const newRecoveryKeyHash = await hashSecretPBKDF2(
    newRecoveryKey.toUpperCase(),
    PASSWORD_PBKDF2_ITERATIONS
  );
  const users = readLocalUsers();
  writeLocalUsers(
    users.map((u) =>
      u.userId === session.userId
        ? { ...u, recoveryKeyHash: newRecoveryKeyHash, updatedAt: new Date().toISOString() }
        : u
    )
  );
  return newRecoveryKey;
}

export async function requestCloudPasswordReset(usernameOrEmail: string): Promise<void> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Mode Cloud Supabase belum dikonfigurasi pada environment ini.');
  }
  const trimmed = usernameOrEmail.trim();
  if (!trimmed) throw new Error('Masukkan username atau email terdaftar.');

  const redirectTo = typeof window !== 'undefined' ? window.location.origin : undefined;

  if (!trimmed.includes('@')) {
    const { error } = await supabase.functions.invoke('username-auth', {
      body: {
        action: 'reset_password',
        identifier: normalizeUsername(trimmed),
        redirectTo,
      },
    });
    if (error) {
      const status =
        typeof (error as { context?: { status?: number } }).context?.status === 'number'
          ? (error as { context: { status: number } }).context.status
          : undefined;
      if (status === 429) {
        throw new Error(
          'Terlalu banyak permintaan reset password. Silakan coba lagi beberapa saat lagi.'
        );
      }
      throw new Error('Gagal memproses permintaan reset password.');
    }
    return;
  }

  const { error } = await supabase.auth.resetPasswordForEmail(trimmed, {
    redirectTo,
  });
  if (error) throw new Error(error.message);
}
