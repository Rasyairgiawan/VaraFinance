import { isSupabaseConfigured, supabase } from '../lib/supabase';
import {
  AccountLinkRecord,
  AuthProviderMode,
  AuthSession,
  AuthUserSummary,
  PinGuardState,
  SecurityPreferences,
} from '../types/finance';
import { generateId, isValidUUID } from '../utils/format';
import {
  getOrCreateDeviceId,
  loadLocalState,
  migrateLegacyLocalStateToUser,
  saveLocalState,
} from './financeRepository';

const AUTH_USERS_KEY = 'kendaliuang_auth_users_v1';
const AUTH_SESSION_KEY = 'kendaliuang_auth_session_v1';
const ACCOUNT_LINKS_KEY = 'kendaliuang_account_links_v1';
const PENDING_CLOUD_PROFILE_PREFIX = 'kendaliuang_pending_cloud_profile_v1_';
const PIN_GUARD_PREFIX = 'kendaliuang_pin_guard_v1_';
const LOGIN_GUARD_KEY = 'kendaliuang_login_guard_v1';
const LOCAL_FINANCE_STORAGE_PREFIX = 'kendaliuang_state_v1';

const PASSWORD_PBKDF2_ITERATIONS = 120_000;
const PIN_PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Strictly aligned with SQL (0004/0005) & username-auth Edge Function: ^[A-Za-z0-9._]{3,24}$
export const USERNAME_VALIDATION_REGEX = /^[a-zA-Z0-9._]{3,24}$/;

export type CloudAuthErrorCode =
  | 'EMAIL_NOT_CONFIRMED'
  | 'CLOUD_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'LINK_CONFLICT'
  | 'ACCOUNT_EXISTS'
  | 'INVALID_CREDENTIALS';

export class CloudAuthError extends Error {
  readonly code: CloudAuthErrorCode;

  constructor(message: string, code: CloudAuthErrorCode) {
    super(message);
    this.name = 'CloudAuthError';
    this.code = code;
  }
}

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
  linkedCloudUserId?: string;
  linkedCloudEmail?: string;
  createdAt: string;
  updatedAt: string;
}

interface PendingCloudProfileSetup {
  userId: string;
  username: string;
  fullName: string;
  email: string;
  pinHash: string;
  createdAt: string;
}

export interface RegisterInput {
  username: string;
  email?: string;
  password: string;
  confirmPassword: string;
  pin: string;
  confirmPin: string;
  mode?: AuthProviderMode;
}

export interface RegisterResult {
  session: AuthSession | null;
  user: AuthUserSummary;
  recoveryKey: string | null; // Shown once in local mode for offline password recovery
  requiresEmailVerification?: boolean;
}

export interface LoginInput {
  username: string;
  password: string;
  preferredMode?: 'auto' | 'local' | 'cloud';
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

export interface LinkAccountResult {
  link: AccountLinkRecord;
  session: AuthSession;
  user: AuthUserSummary;
  alreadyLinked: boolean;
}

export interface RegisterAndLinkResult {
  linked: boolean;
  requiresEmailVerification: boolean;
  link?: AccountLinkRecord;
  session: AuthSession;
  user: AuthUserSummary;
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
  if (!/^[a-zA-Z0-9._]+$/.test(trimmed)) {
    return 'Username hanya boleh berisi huruf, angka, titik (.), atau garis bawah (_).';
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

export function listAccountLinks(): AccountLinkRecord[] {
  try {
    const raw = localStorage.getItem(ACCOUNT_LINKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is AccountLinkRecord =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof item.localUserId === 'string' &&
        item.localUserId.trim().length > 0 &&
        typeof item.cloudUserId === 'string' &&
        isValidUUID(item.cloudUserId) &&
        item.status === 'linked'
    );
  } catch {
    return [];
  }
}

function writeAccountLinks(links: AccountLinkRecord[]): void {
  localStorage.setItem(ACCOUNT_LINKS_KEY, JSON.stringify(links));
}

export function getAccountLinkByLocalUserId(localUserId: string): AccountLinkRecord | null {
  if (!localUserId) return null;
  return listAccountLinks().find((l) => l.localUserId === localUserId) ?? null;
}

export function getAccountLinkByCloudUserId(cloudUserId: string): AccountLinkRecord | null {
  if (!cloudUserId || !isValidUUID(cloudUserId)) return null;
  const normalized = cloudUserId.toLowerCase();
  return listAccountLinks().find((l) => l.cloudUserId.toLowerCase() === normalized) ?? null;
}

/**
 * Resolves the local FinanceState storage owner ID for a session:
 * - If a local account is linked to a Supabase cloud account, BOTH local & cloud logins
 *   resolve to that local account's `localUserId` without migrating/wiping/merging data.
 * - Unlinked cloud accounts resolve strictly to `auth.uid()` (`cloudUserId`).
 * - Unlinked local accounts resolve strictly to `localUserId` (`usr-...`).
 */
export function resolveStorageUserId(session: AuthSession | null | undefined): string | null {
  if (!session) return null;
  if (session.mode === 'local') {
    return session.localUserId || session.userId;
  }
  const cloudId = (session.cloudUserId || session.userId).toLowerCase();
  if (!isValidUUID(cloudId)) return null;
  const link = getAccountLinkByCloudUserId(cloudId);
  return link ? link.localUserId : session.cloudUserId || session.userId;
}

function savePendingCloudProfileSetup(setup: PendingCloudProfileSetup): void {
  try {
    localStorage.setItem(
      `${PENDING_CLOUD_PROFILE_PREFIX}${setup.userId.toLowerCase()}`,
      JSON.stringify(setup)
    );
  } catch {
    // ignore quota errors
  }
}

function consumePendingCloudProfileSetup(userId: string): PendingCloudProfileSetup | null {
  try {
    const key = `${PENDING_CLOUD_PROFILE_PREFIX}${userId.toLowerCase()}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    localStorage.removeItem(key);
    return JSON.parse(raw) as PendingCloudProfileSetup;
  } catch {
    return null;
  }
}

function toUserSummary(u: StoredLocalAuthUser, mode: AuthProviderMode): AuthUserSummary {
  const link = getAccountLinkByLocalUserId(u.userId);
  const linkedCloudUserId = link?.cloudUserId ?? u.linkedCloudUserId;
  const linkedCloudEmail = link?.cloudEmail ?? u.linkedCloudEmail ?? u.email;
  return {
    userId: u.userId,
    username: u.usernameDisplay || u.username,
    email: linkedCloudEmail,
    mode,
    localUserId: u.userId,
    cloudUserId: linkedCloudUserId,
    linkedCloudUserId,
    linkedCloudEmail,
    isLinked: Boolean(linkedCloudUserId),
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

function recordFailedLoginAttempt(currentGuard: PinGuardState): void {
  const nextFails = currentGuard.failedAttempts + 1;
  const lockMs = nextFails >= 8 ? 120_000 : nextFails >= 5 ? 30_000 : 0;
  saveLoginGuard({
    failedAttempts: nextFails,
    lockedUntil: lockMs > 0 ? Date.now() + lockMs : null,
  });
}

function extractHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const rec = err as { status?: unknown; context?: { status?: unknown } };
  if (typeof rec.context?.status === 'number') return rec.context.status;
  if (typeof rec.status === 'number') return rec.status;
  return undefined;
}

function isEmailNotConfirmedError(err: unknown, fnData?: unknown): boolean {
  if (
    fnData &&
    typeof fnData === 'object' &&
    (fnData as { code?: unknown }).code === 'EMAIL_NOT_CONFIRMED'
  ) {
    return true;
  }
  if (!err || typeof err !== 'object') return false;
  const rec = err as { message?: unknown; code?: unknown };
  if (rec.code === 'email_not_confirmed') return true;
  if (typeof rec.message === 'string' && /email not confirmed/i.test(rec.message)) {
    return true;
  }
  return false;
}

function isCloudNetworkUnavailableError(err: unknown): boolean {
  const status = extractHttpStatus(err);
  if (typeof status === 'number') {
    return status >= 500 || status === 0;
  }
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  const msg = String((err as { message?: unknown }).message ?? '');
  if (name === 'FunctionsFetchError' || name === 'AuthRetryableFetchError') return true;
  if (
    /failed to fetch|networkerror|network request failed|fetcherror|timed out|timeout|unreachable|econnrefused|offline/i.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

function hasMeaningfulLocalFinanceData(userId: string): boolean {
  try {
    const raw = localStorage.getItem(`${LOCAL_FINANCE_STORAGE_PREFIX}_${userId}`);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<ReturnType<typeof loadLocalState>>;
    const hasTxs = Array.isArray(parsed.transactions) && parsed.transactions.length > 0;
    const hasProjects = Array.isArray(parsed.projects) && parsed.projects.length > 0;
    const hasSplitBills = Array.isArray(parsed.splitBills) && parsed.splitBills.length > 0;
    const hasCustodial = Array.isArray(parsed.custodialFunds) && parsed.custodialFunds.length > 0;
    const hasAdvances = Array.isArray(parsed.projectAdvances) && parsed.projectAdvances.length > 0;
    const hasAssets = Array.isArray(parsed.physicalAssets) && parsed.physicalAssets.length > 0;
    const hasLoans = Array.isArray(parsed.physicalItemLoans) && parsed.physicalItemLoans.length > 0;
    const hasTransfers = Array.isArray(parsed.transfers) && parsed.transfers.length > 0;
    const hasLogs = Array.isArray(parsed.changeLogs) && parsed.changeLogs.length > 0;
    return (
      hasTxs ||
      hasProjects ||
      hasSplitBills ||
      hasCustodial ||
      hasAdvances ||
      hasAssets ||
      hasLoans ||
      hasTransfers ||
      hasLogs
    );
  } catch {
    return false;
  }
}

function createSessionRecord(params: {
  userId: string;
  username: string;
  email?: string;
  mode: AuthProviderMode;
  localUserId?: string;
  cloudUserId?: string;
  expiresAtMs?: number;
}): AuthSession {
  const now = new Date();
  const expiresMs =
    typeof params.expiresAtMs === 'number' && Number.isFinite(params.expiresAtMs)
      ? params.expiresAtMs
      : now.getTime() + SESSION_TTL_MS;
  const expires = new Date(expiresMs);

  let resolvedLocalId = params.localUserId;
  let resolvedCloudId = params.cloudUserId;
  if (params.mode === 'local') {
    resolvedLocalId = resolvedLocalId ?? params.userId;
    resolvedCloudId = resolvedCloudId ?? getAccountLinkByLocalUserId(resolvedLocalId)?.cloudUserId;
  } else {
    resolvedCloudId = resolvedCloudId ?? params.userId;
    resolvedLocalId = resolvedLocalId ?? getAccountLinkByCloudUserId(resolvedCloudId)?.localUserId;
  }

  const storageUserId =
    params.mode === 'local'
      ? resolvedLocalId!
      : resolvedLocalId ?? resolvedCloudId!;

  const session: AuthSession = {
    userId: params.userId,
    username: params.username,
    email: params.email,
    mode: params.mode,
    ...(resolvedLocalId ? { localUserId: resolvedLocalId } : {}),
    ...(resolvedCloudId ? { cloudUserId: resolvedCloudId } : {}),
    storageUserId,
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

    if (parsed.mode === 'local') {
      const localId = parsed.localUserId || parsed.userId;
      const users = readLocalUsers();
      const exists = users.some((u) => u.userId === localId);
      if (!exists) {
        localStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }
      const link = getAccountLinkByLocalUserId(localId);
      return {
        ...parsed,
        userId: localId,
        localUserId: localId,
        cloudUserId: link?.cloudUserId,
        storageUserId: localId,
      };
    }

    // Cloud mode: cloud userId MUST be a valid Supabase auth.uid() UUID (never usr-*)
    const cloudId = parsed.cloudUserId || parsed.userId;
    if (!isValidUUID(cloudId)) {
      localStorage.removeItem(AUTH_SESSION_KEY);
      return null;
    }
    const link = getAccountLinkByCloudUserId(cloudId);
    return {
      ...parsed,
      userId: cloudId,
      cloudUserId: cloudId,
      localUserId: link?.localUserId,
      storageUserId: link ? link.localUserId : cloudId,
    };
  } catch {
    return null;
  }
}

export function touchSessionActivity(): AuthSession | null {
  const current = getStoredSession();
  if (!current) return null;
  const now = new Date();
  const nextExpiresAt =
    current.mode === 'cloud'
      ? current.expiresAt
      : new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const updated: AuthSession = {
    ...current,
    lastActiveAt: now.toISOString(),
    expiresAt: nextExpiresAt,
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
    const localId = session.localUserId || session.userId;
    const u = readLocalUsers().find((x) => x.userId === localId);
    return u ? toUserSummary(u, 'local') : null;
  }

  const cloudId = session.cloudUserId || session.userId;
  const link = getAccountLinkByCloudUserId(cloudId);
  const storageId = link ? link.localUserId : cloudId;
  const state = loadLocalState(storageId);

  return {
    userId: cloudId,
    username: state.settings.username || link?.cloudUsername || session.username,
    email: session.email || link?.cloudEmail,
    mode: 'cloud',
    cloudUserId: cloudId,
    ...(link ? { localUserId: link.localUserId, linkedLocalUserId: link.localUserId } : {}),
    linkedCloudEmail: session.email || link?.cloudEmail,
    isLinked: Boolean(link),
    pinConfigured: Boolean(state.settings.securityPinHash),
    pinEnabled: Boolean(state.settings.pinEnabled && state.settings.securityPinHash),
    requirePinOnReopen: state.settings.requirePinOnReopen ?? true,
    autoLockMinutes: state.settings.autoLockMinutes ?? 5,
    createdAt: session.issuedAt,
    updatedAt: session.lastActiveAt,
  };
}

async function applyPendingCloudProfileBootstrap(supaUser: {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!supabase || !isSupabaseConfigured) return;
  const pending = consumePendingCloudProfileSetup(supaUser.id);
  const metaUsername =
    typeof supaUser.user_metadata?.username === 'string'
      ? supaUser.user_metadata.username.trim()
      : undefined;

  if (!pending && !metaUsername) return;

  const link = getAccountLinkByCloudUserId(supaUser.id);
  const storageId = link ? link.localUserId : supaUser.id;
  const currentState = loadLocalState(storageId);

  if (pending) {
    const nextState = {
      ...currentState,
      settings: {
        ...currentState.settings,
        fullName:
          currentState.settings.fullName === 'Pengguna VaraFinance' ||
          currentState.settings.fullName === 'Pengguna KendaliUang'
            ? pending.fullName
            : currentState.settings.fullName,
        username: pending.username,
        securityPinHash: currentState.settings.securityPinHash || pending.pinHash,
        pinEnabled: true,
        requirePinOnReopen: currentState.settings.requirePinOnReopen ?? true,
        autoLockMinutes: currentState.settings.autoLockMinutes ?? 5,
      },
    };
    saveLocalState(nextState, storageId);
  }

  try {
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('id', supaUser.id)
      .maybeSingle();

    if (!existingProfile) {
      await supabase.from('profiles').upsert({
        id: supaUser.id,
        full_name: pending?.fullName ?? currentState.settings.fullName,
        username: pending?.username ?? metaUsername ?? currentState.settings.username ?? null,
        recovery_email: supaUser.email ?? pending?.email ?? null,
        security_pin_hash: pending?.pinHash ?? currentState.settings.securityPinHash ?? null,
        pin_enabled: Boolean(pending?.pinHash || currentState.settings.pinEnabled),
        require_pin_on_reopen: currentState.settings.requirePinOnReopen ?? true,
        auto_lock_minutes: currentState.settings.autoLockMinutes ?? 5,
      });
    } else if (!existingProfile.username && (pending?.username || metaUsername)) {
      await supabase
        .from('profiles')
        .update({ username: pending?.username ?? metaUsername })
        .eq('id', supaUser.id);
    }
  } catch {
    // Non-blocking profile sync if offline
  }
}

export async function resolveValidSession(): Promise<AuthSession | null> {
  const localSess = getStoredSession();

  // Never overwrite an active Local Mode session with a leftover cloud session
  if (localSess?.mode === 'local') {
    return localSess;
  }

  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        if (isCloudNetworkUnavailableError(error) && localSess) {
          return localSess;
        }
        if (localSess?.mode === 'cloud') {
          localStorage.removeItem(AUTH_SESSION_KEY);
        }
        return null;
      }

      let activeSession = data.session;
      if (activeSession) {
        const expiresAtMs =
          typeof activeSession.expires_at === 'number'
            ? activeSession.expires_at * 1000
            : undefined;
        // Refresh token proactively if expired or expiring within 60 seconds
        if (expiresAtMs !== undefined && expiresAtMs <= Date.now() + 60_000) {
          const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
          if (refreshErr || !refreshed.session?.user) {
            if (isCloudNetworkUnavailableError(refreshErr) && localSess && expiresAtMs > Date.now()) {
              return localSess;
            }
            localStorage.removeItem(AUTH_SESSION_KEY);
            try {
              await supabase.auth.signOut();
            } catch {
              // ignore signOut failure
            }
            return null;
          }
          activeSession = refreshed.session;
        }

        const supaUser = activeSession.user;
        if (supaUser) {
          await applyPendingCloudProfileBootstrap(supaUser);
          const link = getAccountLinkByCloudUserId(supaUser.id);
          const refreshedExpiresMs =
            typeof activeSession.expires_at === 'number'
              ? activeSession.expires_at * 1000
              : undefined;
          const usernameFromMeta =
            (supaUser.user_metadata?.username as string | undefined) ||
            link?.cloudUsername ||
            supaUser.email?.split('@')[0] ||
            'pengguna';

          if (
            localSess &&
            localSess.mode === 'cloud' &&
            localSess.userId === supaUser.id &&
            localSess.localUserId === link?.localUserId
          ) {
            if (refreshedExpiresMs && refreshedExpiresMs > Date.parse(localSess.expiresAt)) {
              return createSessionRecord({
                userId: supaUser.id,
                username: localSess.username || usernameFromMeta,
                email: supaUser.email ?? localSess.email,
                mode: 'cloud',
                localUserId: link?.localUserId,
                cloudUserId: supaUser.id,
                expiresAtMs: refreshedExpiresMs,
              });
            }
            return localSess;
          }

          return createSessionRecord({
            userId: supaUser.id,
            username: usernameFromMeta,
            email: supaUser.email ?? undefined,
            mode: 'cloud',
            localUserId: link?.localUserId,
            cloudUserId: supaUser.id,
            expiresAtMs: refreshedExpiresMs,
          });
        }
      }

      // Supabase reports no active cloud session: clear stale cloud session marker
      if (localSess?.mode === 'cloud') {
        localStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }
    } catch {
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
  const targetMode: AuthProviderMode =
    input.mode ?? (isSupabaseConfigured && supabase ? 'cloud' : 'local');

  if (targetMode === 'cloud') {
    if (!isSupabaseConfigured || !supabase) {
      throw new Error('Mode Cloud Supabase belum dikonfigurasi pada environment ini.');
    }

    const email = input.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(
        'Email valid diperlukan untuk pembuatan akun Cloud Supabase & pemulihan password.'
      );
    }

    const { data: availData, error: availErr } = await supabase.functions.invoke('username-auth', {
      body: { action: 'check_username', username: normalized },
    });
    if (availErr) {
      const status = extractHttpStatus(availErr);
      if (status === 429) {
        throw new CloudAuthError(
          'Terlalu banyak percobaan verifikasi username. Silakan coba lagi beberapa saat lagi.',
          'RATE_LIMITED'
        );
      }
      throw new CloudAuthError(
        'Layanan verifikasi username sedang tidak tersedia. Pendaftaran akun cloud tidak dapat dilanjutkan saat ini.',
        'CLOUD_UNAVAILABLE'
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
    if (error) {
      if (/already registered|user already exists/i.test(error.message)) {
        throw new CloudAuthError(
          'Email ini sudah terdaftar pada Cloud Supabase. Silakan masuk atau gunakan pemulihan password.',
          'ACCOUNT_EXISTS'
        );
      }
      throw new Error(error.message);
    }
    if (!data.user) throw new Error('Pendaftaran akun gagal diproses oleh Supabase.');

    // Supabase obfuscates duplicate emails during signup by returning identities = [] with no session
    const userWithIdentities = data.user as { id: string; identities?: unknown[] };
    if (Array.isArray(userWithIdentities.identities) && userWithIdentities.identities.length === 0) {
      throw new CloudAuthError(
        'Email ini sudah terdaftar pada Cloud Supabase. Silakan masuk atau gunakan pemulihan password.',
        'ACCOUNT_EXISTS'
      );
    }

    const cloudUserId = data.user.id;
    const nowISO = new Date().toISOString();

    if (!data.session) {
      // Email verification required: DO NOT create active AuthSession or overwrite localStorage yet!
      savePendingCloudProfileSetup({
        userId: cloudUserId,
        username: displayUsername,
        fullName: displayUsername,
        email,
        pinHash,
        createdAt: nowISO,
      });

      return {
        session: null,
        user: {
          userId: cloudUserId,
          cloudUserId,
          username: displayUsername,
          email,
          mode: 'cloud',
          isLinked: false,
          pinConfigured: true,
          pinEnabled: true,
          requirePinOnReopen: true,
          autoLockMinutes: 5,
          createdAt: nowISO,
          updatedAt: nowISO,
        },
        recoveryKey: null,
        requiresEmailVerification: true,
      };
    }

    if (!hasAnyRegisteredLocalUser() && listAccountLinks().length === 0) {
      migrateLegacyLocalStateToUser(cloudUserId);
    }
    const currentState = loadLocalState(cloudUserId);
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
    saveLocalState(updatedState, cloudUserId);

    const { error: profileErr } = await supabase.from('profiles').upsert({
      id: cloudUserId,
      full_name: updatedState.settings.fullName,
      username: displayUsername,
      recovery_email: email,
      security_pin_hash: pinHash,
      pin_enabled: true,
      require_pin_on_reopen: true,
      auto_lock_minutes: 5,
    });
    if (profileErr) {
      throw new Error(`Akun dibuat, tetapi gagal menyimpan profil cloud: ${profileErr.message}`);
    }

    const sessionExpiresMs =
      typeof data.session.expires_at === 'number' ? data.session.expires_at * 1000 : undefined;
    const session = createSessionRecord({
      userId: cloudUserId,
      cloudUserId,
      username: displayUsername,
      email,
      mode: 'cloud',
      expiresAtMs: sessionExpiresMs,
    });

    return {
      session,
      user: {
        userId: cloudUserId,
        cloudUserId,
        username: displayUsername,
        email,
        mode: 'cloud',
        isLinked: false,
        pinConfigured: true,
        pinEnabled: true,
        requirePinOnReopen: true,
        autoLockMinutes: 5,
        createdAt: nowISO,
        updatedAt: nowISO,
      },
      recoveryKey: null,
      requiresEmailVerification: false,
    };
  }

  // Local Offline-First Mode
  const users = readLocalUsers();
  if (users.some((u) => u.username === normalized)) {
    throw new Error(
      `Username "${displayUsername}" sudah terdaftar. Pilih username lain atau silakan login.`
    );
  }

  const userId = `usr-${generateId()}`;
  const isFirstLocalUser = users.length === 0 && listAccountLinks().length === 0;
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
    localUserId: userId,
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

async function authenticateLocalCredentials(
  rawIdentifier: string,
  password: string,
  loginGuard: PinGuardState
): Promise<{ session: AuthSession; user: AuthUserSummary }> {
  const normalized = normalizeUsername(rawIdentifier);
  const users = readLocalUsers();
  const matched = users.find((u) => u.username === normalized);
  const ok = matched ? await verifySecretPBKDF2(password, matched.passwordHash) : false;

  if (!matched || !ok) {
    recordFailedLoginAttempt(loginGuard);
    throw new CloudAuthError(
      'Username atau password salah. Periksa kembali kredensial Anda.',
      'INVALID_CREDENTIALS'
    );
  }

  clearLoginGuard();
  const link = getAccountLinkByLocalUserId(matched.userId);
  const session = createSessionRecord({
    userId: matched.userId,
    localUserId: matched.userId,
    cloudUserId: link?.cloudUserId,
    username: matched.usernameDisplay || matched.username,
    email: link?.cloudEmail ?? matched.email,
    mode: 'local',
  });

  return {
    session,
    user: toUserSummary(matched, 'local'),
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

  const preferredMode = input.preferredMode ?? 'auto';
  const isEmailIdentifier = rawIdentifier.includes('@');

  // Explicit Local Mode or Supabase not configured: strictly local PBKDF2 login
  if (preferredMode === 'local' || !isSupabaseConfigured || !supabase) {
    if (isEmailIdentifier) {
      throw new Error(
        'Login dengan email memerlukan koneksi Cloud Supabase. Gunakan username akun lokal Anda untuk masuk secara offline.'
      );
    }
    return authenticateLocalCredentials(rawIdentifier, input.password, loginGuard);
  }

  let authUser: { id: string; email?: string | null; user_metadata?: Record<string, unknown> } | null =
    null;
  let resolvedUsername: string | undefined;
  let expiresAtMs: number | undefined;

  if (!isEmailIdentifier) {
    const normalized = normalizeUsername(rawIdentifier);
    const localUsers = readLocalUsers();
    const matchedLocal = localUsers.find((u) => u.username === normalized);

    let invokeResult: { data: Record<string, unknown> | null; error: unknown };
    try {
      const res = await supabase.functions.invoke('username-auth', {
        body: {
          action: 'login',
          username: normalized,
          password: input.password,
        },
      });
      invokeResult = { data: res.data as Record<string, unknown> | null, error: res.error };
    } catch (networkErr) {
      invokeResult = { data: null, error: networkErr };
    }

    const { data: fnData, error: fnErr } = invokeResult;

    if (fnErr || !fnData?.access_token || !fnData?.refresh_token) {
      const status = extractHttpStatus(fnErr);

      if (status === 429) {
        recordFailedLoginAttempt(loginGuard);
        throw new CloudAuthError(
          'Terlalu banyak percobaan login. Silakan coba lagi beberapa saat lagi.',
          'RATE_LIMITED'
        );
      }

      if (status === 403 || isEmailNotConfirmedError(fnErr, fnData)) {
        throw new CloudAuthError(
          'Email akun Anda belum diverifikasi. Silakan periksa kotak masuk email untuk tautan verifikasi sebelum masuk.',
          'EMAIL_NOT_CONFIRMED'
        );
      }

      // Network / Edge unavailability: fallback cleanly for existing local users so offline access works
      if (isCloudNetworkUnavailableError(fnErr) || (fnErr && status === undefined)) {
        if (matchedLocal) {
          return authenticateLocalCredentials(rawIdentifier, input.password, loginGuard);
        }
        throw new CloudAuthError(
          'Layanan autentikasi cloud sedang tidak tersedia atau perangkat offline.',
          'CLOUD_UNAVAILABLE'
        );
      }

      // Old unlinked local user on this device when Supabase is enabled: allow local login ONLY for their unlinked local account
      if (matchedLocal && !getAccountLinkByLocalUserId(matchedLocal.userId)) {
        return authenticateLocalCredentials(rawIdentifier, input.password, loginGuard);
      }

      recordFailedLoginAttempt(loginGuard);
      throw new CloudAuthError('Username atau password tidak sesuai.', 'INVALID_CREDENTIALS');
    }

    const { data: sessionData, error: setSessionErr } = await supabase.auth.setSession({
      access_token: String(fnData.access_token),
      refresh_token: String(fnData.refresh_token),
    });
    if (setSessionErr || !sessionData.user) {
      throw new Error('Gagal membangun sesi autentikasi cloud.');
    }
    authUser = sessionData.user;
    expiresAtMs =
      typeof sessionData.session?.expires_at === 'number'
        ? sessionData.session.expires_at * 1000
        : undefined;
    const fnUser = fnData.user as { username?: string } | undefined;
    resolvedUsername = fnUser?.username;
  } else {
    const normalizedEmail = rawIdentifier.toLowerCase();
    let signInResult: Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>;
    try {
      signInResult = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password: input.password,
      });
    } catch {
      throw new CloudAuthError(
        'Tidak dapat terhubung ke server Supabase. Periksa koneksi internet Anda.',
        'CLOUD_UNAVAILABLE'
      );
    }

    const { data, error } = signInResult;
    if (error || !data.user) {
      if (isEmailNotConfirmedError(error)) {
        throw new CloudAuthError(
          'Email akun Anda belum diverifikasi. Silakan periksa kotak masuk email untuk tautan verifikasi sebelum masuk.',
          'EMAIL_NOT_CONFIRMED'
        );
      }
      if (isCloudNetworkUnavailableError(error)) {
        throw new CloudAuthError(
          'Server autentikasi cloud tidak dapat dijangkau. Coba lagi saat koneksi tersedia.',
          'CLOUD_UNAVAILABLE'
        );
      }
      recordFailedLoginAttempt(loginGuard);
      throw new CloudAuthError('Username atau password tidak sesuai.', 'INVALID_CREDENTIALS');
    }

    authUser = data.user;
    expiresAtMs =
      typeof data.session?.expires_at === 'number' ? data.session.expires_at * 1000 : undefined;
  }

  clearLoginGuard();
  await applyPendingCloudProfileBootstrap(authUser);

  const link = getAccountLinkByCloudUserId(authUser.id);
  const displayUsername =
    resolvedUsername ||
    (authUser.user_metadata?.username as string | undefined) ||
    link?.cloudUsername ||
    (isEmailIdentifier ? rawIdentifier.split('@')[0] : rawIdentifier);

  const session = createSessionRecord({
    userId: authUser.id,
    cloudUserId: authUser.id,
    localUserId: link?.localUserId,
    username: displayUsername,
    email: authUser.email ?? (isEmailIdentifier ? rawIdentifier.toLowerCase() : undefined),
    mode: 'cloud',
    expiresAtMs,
  });
  const summary = getUserSummaryForSession(session)!;
  return { session, user: summary };
}

/**
 * Explicitly links an authenticated Local account (`usr-...`) to an existing Supabase Cloud
 * account (`auth.uid()`). Requires proving ownership of the target Supabase account via credentials.
 * - Idempotent when linking the same `(localUserId, cloudUserId)` pair.
 * - Fails safely without altering local FinanceState, activeUserId, or merging separate accounts.
 */
export async function linkLocalAccountToExistingCloud(
  session: AuthSession,
  input: { identifier: string; password: string }
): Promise<LinkAccountResult> {
  if (!isSupabaseConfigured || !supabase) {
    throw new CloudAuthError(
      'Mode Cloud Supabase belum dikonfigurasi pada environment ini.',
      'CLOUD_UNAVAILABLE'
    );
  }

  const localUserId = session.localUserId || session.userId;
  const users = readLocalUsers();
  const localUser = users.find((u) => u.userId === localUserId);
  if (!localUser) {
    throw new Error('Akun lokal aktif tidak ditemukan pada perangkat ini.');
  }

  const rawIdentifier = input.identifier.trim();
  if (!rawIdentifier || !input.password) {
    throw new Error('Username/email cloud dan password wajib diisi untuk menautkan akun.');
  }

  const existingLocalLink = getAccountLinkByLocalUserId(localUserId);

  let authUser: { id: string; email?: string | null; user_metadata?: Record<string, unknown> } | null =
    null;
  let expiresAtMs: number | undefined;
  let resolvedCloudUsername: string | undefined;

  if (!rawIdentifier.includes('@')) {
    const normalized = normalizeUsername(rawIdentifier);
    let fnRes: { data: Record<string, unknown> | null; error: unknown };
    try {
      const res = await supabase.functions.invoke('username-auth', {
        body: { action: 'login', username: normalized, password: input.password },
      });
      fnRes = { data: res.data as Record<string, unknown> | null, error: res.error };
    } catch {
      throw new CloudAuthError(
        'Tidak dapat menjangkau layanan autentikasi Supabase. Data lokal Anda tetap aman.',
        'CLOUD_UNAVAILABLE'
      );
    }

    if (fnRes.error || !fnRes.data?.access_token || !fnRes.data?.refresh_token) {
      const status = extractHttpStatus(fnRes.error);
      if (status === 429) {
        throw new CloudAuthError(
          'Terlalu banyak percobaan autentikasi. Silakan coba lagi nanti.',
          'RATE_LIMITED'
        );
      }
      if (status === 403 || isEmailNotConfirmedError(fnRes.error, fnRes.data)) {
        throw new CloudAuthError(
          'Email akun cloud belum diverifikasi. Verifikasi email terlebih dahulu sebelum menautkan.',
          'EMAIL_NOT_CONFIRMED'
        );
      }
      if (isCloudNetworkUnavailableError(fnRes.error) || status === undefined) {
        throw new CloudAuthError(
          'Layanan cloud tidak tersedia. Data lokal Anda tetap utuh dan tidak berubah.',
          'CLOUD_UNAVAILABLE'
        );
      }
      throw new CloudAuthError('Kredensial akun cloud tidak sesuai.', 'INVALID_CREDENTIALS');
    }

    const { data: sessionData, error: setErr } = await supabase.auth.setSession({
      access_token: String(fnRes.data.access_token),
      refresh_token: String(fnRes.data.refresh_token),
    });
    if (setErr || !sessionData.user) {
      throw new Error('Gagal memverifikasi sesi cloud.');
    }
    authUser = sessionData.user;
    expiresAtMs =
      typeof sessionData.session?.expires_at === 'number'
        ? sessionData.session.expires_at * 1000
        : undefined;
    resolvedCloudUsername = (fnRes.data.user as { username?: string } | undefined)?.username;
  } else {
    let signInRes: Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>;
    try {
      signInRes = await supabase.auth.signInWithPassword({
        email: rawIdentifier.toLowerCase(),
        password: input.password,
      });
    } catch {
      throw new CloudAuthError(
        'Koneksi ke Supabase gagal. Data lokal Anda tetap aman dan belum berubah.',
        'CLOUD_UNAVAILABLE'
      );
    }
    if (signInRes.error || !signInRes.data.user) {
      if (isEmailNotConfirmedError(signInRes.error)) {
        throw new CloudAuthError(
          'Email akun cloud belum diverifikasi. Verifikasi email terlebih dahulu sebelum menautkan.',
          'EMAIL_NOT_CONFIRMED'
        );
      }
      if (isCloudNetworkUnavailableError(signInRes.error)) {
        throw new CloudAuthError(
          'Server cloud tidak dapat dijangkau. Data lokal Anda tetap utuh.',
          'CLOUD_UNAVAILABLE'
        );
      }
      throw new CloudAuthError('Email atau password cloud tidak sesuai.', 'INVALID_CREDENTIALS');
    }
    authUser = signInRes.data.user;
    expiresAtMs =
      typeof signInRes.data.session?.expires_at === 'number'
        ? signInRes.data.session.expires_at * 1000
        : undefined;
  }

  const cloudUserId = authUser.id;
  if (!isValidUUID(cloudUserId)) {
    throw new Error('Identitas Supabase auth.uid() tidak valid.');
  }

  const abortMismatchedCloudSession = async () => {
    try {
      await supabase!.auth.signOut();
    } catch {
      // ignore offline signOut failure
    }
  };

  // Prevent re-linking local account to a DIFFERENT cloud identity
  if (existingLocalLink && existingLocalLink.cloudUserId.toLowerCase() !== cloudUserId.toLowerCase()) {
    await abortMismatchedCloudSession();
    throw new CloudAuthError(
      'Akun lokal ini sudah tertaut ke identitas cloud lain. Penautan silang ditolak untuk menjaga isolasi data.',
      'LINK_CONFLICT'
    );
  }

  // Prevent linking one cloud identity to MULTIPLE local accounts
  const existingCloudLink = getAccountLinkByCloudUserId(cloudUserId);
  if (existingCloudLink && existingCloudLink.localUserId !== localUserId) {
    await abortMismatchedCloudSession();
    throw new CloudAuthError(
      'Akun Cloud Supabase ini sudah tertaut ke akun lokal lain. Satu identitas cloud tidak boleh tertaut ke lebih dari satu akun lokal tanpa pemisahan eksplisit.',
      'LINK_CONFLICT'
    );
  }

  // Prevent silently eclipsing separate local data that already exists under cloudUserId
  if (!existingLocalLink && hasMeaningfulLocalFinanceData(cloudUserId)) {
    await abortMismatchedCloudSession();
    throw new CloudAuthError(
      'Akun Cloud ini sudah memiliki data keuangan lokal terpisah di perangkat ini. Penggabungan otomatis dua akun dinonaktifkan untuk mencegah pencampuran data.',
      'LINK_CONFLICT'
    );
  }

  // Check / create profile safely without overwriting an existing different cloud profile username
  let finalCloudUsername =
    resolvedCloudUsername ||
    (authUser.user_metadata?.username as string | undefined) ||
    localUser.usernameDisplay;
  try {
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id, username, full_name')
      .eq('id', cloudUserId)
      .maybeSingle();

    if (existingProfile) {
      if (existingProfile.username) {
        finalCloudUsername = existingProfile.username;
      }
    } else {
      const localState = loadLocalState(localUserId);
      const { error: upsertErr } = await supabase.from('profiles').upsert({
        id: cloudUserId,
        full_name: localState.settings.fullName || localUser.usernameDisplay,
        username: USERNAME_VALIDATION_REGEX.test(localUser.usernameDisplay)
          ? localUser.usernameDisplay
          : null,
        recovery_email: authUser.email ?? null,
        security_pin_hash: localUser.pinHash ?? localState.settings.securityPinHash ?? null,
        pin_enabled: localUser.pinEnabled,
        require_pin_on_reopen: localUser.requirePinOnReopen,
        auto_lock_minutes: localUser.autoLockMinutes,
      });
      if (upsertErr) {
        await abortMismatchedCloudSession();
        throw new Error(`Gagal menyiapkan profil cloud: ${upsertErr.message}`);
      }
    }
  } catch (err) {
    if (err instanceof CloudAuthError) throw err;
    if (err instanceof Error && err.message.startsWith('Gagal menyiapkan profil cloud')) {
      throw err;
    }
  }

  const nowISO = new Date().toISOString();
  const alreadyLinked = Boolean(
    existingLocalLink && existingLocalLink.cloudUserId.toLowerCase() === cloudUserId.toLowerCase()
  );

  const linkRecord: AccountLinkRecord = {
    localUserId,
    cloudUserId,
    cloudEmail: authUser.email ?? existingLocalLink?.cloudEmail,
    cloudUsername: finalCloudUsername,
    linkedAt: existingLocalLink?.linkedAt ?? nowISO,
    updatedAt: nowISO,
    status: 'linked',
  };

  const links = listAccountLinks();
  const nextLinks = alreadyLinked
    ? links.map((l) => (l.localUserId === localUserId ? linkRecord : l))
    : [...links, linkRecord];
  writeAccountLinks(nextLinks);

  writeLocalUsers(
    users.map((u) =>
      u.userId === localUserId
        ? {
            ...u,
            linkedCloudUserId: cloudUserId,
            linkedCloudEmail: linkRecord.cloudEmail ?? u.linkedCloudEmail,
            email: linkRecord.cloudEmail ?? u.email,
            updatedAt: nowISO,
          }
        : u
    )
  );

  const nextSession = createSessionRecord({
    userId: cloudUserId,
    cloudUserId,
    localUserId,
    username: finalCloudUsername || localUser.usernameDisplay,
    email: linkRecord.cloudEmail,
    mode: 'cloud',
    expiresAtMs,
  });

  const nextUser = getUserSummaryForSession(nextSession)!;
  return {
    link: linkRecord,
    session: nextSession,
    user: nextUser,
    alreadyLinked,
  };
}

/**
 * Registers a brand new Supabase Cloud account from an unlinked local account and links it
 * atomically once verified. If email verification is required, keeps the local session intact
 * until the user confirms email and completes linking via `linkLocalAccountToExistingCloud`.
 */
export async function registerAndLinkCloudAccount(
  session: AuthSession,
  input: {
    username: string;
    email: string;
    password: string;
    confirmPassword: string;
  }
): Promise<RegisterAndLinkResult> {
  if (!isSupabaseConfigured || !supabase) {
    throw new CloudAuthError(
      'Mode Cloud Supabase belum dikonfigurasi pada environment ini.',
      'CLOUD_UNAVAILABLE'
    );
  }

  const localUserId = session.localUserId || session.userId;
  const users = readLocalUsers();
  const localUser = users.find((u) => u.userId === localUserId);
  if (!localUser) {
    throw new Error('Akun lokal aktif tidak ditemukan.');
  }
  const existingLink = getAccountLinkByLocalUserId(localUserId);
  if (existingLink) {
    throw new CloudAuthError(
      'Akun lokal ini sudah tertaut ke akun Cloud Supabase.',
      'LINK_CONFLICT'
    );
  }

  const usernameErr = validateUsername(input.username);
  if (usernameErr) throw new Error(usernameErr);
  const normalized = normalizeUsername(input.username);
  const displayUsername = input.username.trim();

  const email = input.email.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Masukkan alamat email yang valid.');
  }

  const pwdCheck = evaluatePasswordStrength(input.password);
  if (!pwdCheck.valid) {
    throw new Error(`Password belum memenuhi standar keamanan: ${pwdCheck.errors.join(' ')}`);
  }
  if (input.password !== input.confirmPassword) {
    throw new Error('Konfirmasi password tidak cocok.');
  }

  const { data: availData, error: availErr } = await supabase.functions.invoke('username-auth', {
    body: { action: 'check_username', username: normalized },
  });
  if (availErr) {
    const status = extractHttpStatus(availErr);
    if (status === 429) {
      throw new CloudAuthError('Terlalu banyak permintaan. Coba lagi nanti.', 'RATE_LIMITED');
    }
    throw new CloudAuthError(
      'Layanan verifikasi username cloud sedang tidak tersedia. Data lokal Anda tetap aman.',
      'CLOUD_UNAVAILABLE'
    );
  }
  if (!availData || availData.available !== true) {
    throw new Error('Username cloud tidak tersedia atau sudah dipakai akun lain.');
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password: input.password,
    options: { data: { username: displayUsername } },
  });
  if (error) throw new Error(error.message);
  if (!data.user) throw new Error('Gagal membuat akun Cloud Supabase.');

  const userWithIdentities = data.user as { id: string; identities?: unknown[] };
  if (Array.isArray(userWithIdentities.identities) && userWithIdentities.identities.length === 0) {
    throw new CloudAuthError(
      'Email ini sudah terdaftar di Supabase. Gunakan opsi "Tautkan ke Akun Cloud yang Sudah Ada".',
      'ACCOUNT_EXISTS'
    );
  }

  if (!data.session) {
    return {
      linked: false,
      requiresEmailVerification: true,
      session,
      user: toUserSummary(localUser, 'local'),
    };
  }

  const cloudUserId = data.user.id;
  const localState = loadLocalState(localUserId);
  const { error: profileErr } = await supabase.from('profiles').upsert({
    id: cloudUserId,
    full_name: localState.settings.fullName || displayUsername,
    username: displayUsername,
    recovery_email: email,
    security_pin_hash: localUser.pinHash ?? localState.settings.securityPinHash ?? null,
    pin_enabled: localUser.pinEnabled,
    require_pin_on_reopen: localUser.requirePinOnReopen,
    auto_lock_minutes: localUser.autoLockMinutes,
  });
  if (profileErr) {
    throw new Error(`Akun cloud terbuat, tetapi gagal menyimpan profil: ${profileErr.message}`);
  }

  const nowISO = new Date().toISOString();
  const linkRecord: AccountLinkRecord = {
    localUserId,
    cloudUserId,
    cloudEmail: email,
    cloudUsername: displayUsername,
    linkedAt: nowISO,
    updatedAt: nowISO,
    status: 'linked',
  };
  writeAccountLinks([...listAccountLinks(), linkRecord]);
  writeLocalUsers(
    users.map((u) =>
      u.userId === localUserId
        ? {
            ...u,
            linkedCloudUserId: cloudUserId,
            linkedCloudEmail: email,
            email: u.email ?? email,
            updatedAt: nowISO,
          }
        : u
    )
  );

  const expiresAtMs =
    typeof data.session.expires_at === 'number' ? data.session.expires_at * 1000 : undefined;
  const nextSession = createSessionRecord({
    userId: cloudUserId,
    cloudUserId,
    localUserId,
    username: displayUsername,
    email,
    mode: 'cloud',
    expiresAtMs,
  });

  return {
    linked: true,
    requiresEmailVerification: false,
    link: linkRecord,
    session: nextSession,
    user: getUserSummaryForSession(nextSession)!,
  };
}

export async function resendCloudVerificationEmail(email: string): Promise<void> {
  if (!isSupabaseConfigured || !supabase) {
    throw new CloudAuthError(
      'Mode Cloud Supabase belum dikonfigurasi.',
      'CLOUD_UNAVAILABLE'
    );
  }
  const normalized = email.trim().toLowerCase();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Masukkan alamat email yang valid untuk mengirim ulang verifikasi.');
  }
  const redirectTo = typeof window !== 'undefined' ? window.location.origin : undefined;
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: normalized,
    options: redirectTo ? { emailRedirectTo: redirectTo } : undefined,
  });
  if (error) throw new Error(error.message);
}

export async function completeCloudPasswordReset(
  newPassword: string,
  confirmPassword: string
): Promise<void> {
  if (!isSupabaseConfigured || !supabase) {
    throw new CloudAuthError('Mode Cloud Supabase belum dikonfigurasi.', 'CLOUD_UNAVAILABLE');
  }
  const pwdCheck = evaluatePasswordStrength(newPassword);
  if (!pwdCheck.valid) {
    throw new Error(`Password baru belum memenuhi standar keamanan: ${pwdCheck.errors.join(' ')}`);
  }
  if (newPassword !== confirmPassword) {
    throw new Error('Konfirmasi password baru tidak cocok.');
  }
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}

export function subscribeCloudAuthChanges(handlers: {
  onTokenRefreshed?: (session: AuthSession) => void;
  onSignedOut?: () => void;
  onPasswordRecovery?: () => void;
}): () => void {
  if (!isSupabaseConfigured || !supabase) {
    return () => {};
  }

  const { data: listener } = supabase.auth.onAuthStateChange((event, supaSession) => {
    if (event === 'PASSWORD_RECOVERY') {
      handlers.onPasswordRecovery?.();
      return;
    }

    const currentLocal = getStoredSession();
    if (event === 'SIGNED_OUT') {
      if (currentLocal?.mode === 'cloud') {
        localStorage.removeItem(AUTH_SESSION_KEY);
        handlers.onSignedOut?.();
      }
      return;
    }

    if (event === 'TOKEN_REFRESHED' && supaSession?.user) {
      // Never hijack an explicit local session
      if (currentLocal?.mode === 'local') return;
      const u = supaSession.user;
      const link = getAccountLinkByCloudUserId(u.id);
      const expiresAtMs =
        typeof supaSession.expires_at === 'number' ? supaSession.expires_at * 1000 : undefined;
      const updated = createSessionRecord({
        userId: u.id,
        cloudUserId: u.id,
        localUserId: link?.localUserId,
        username:
          currentLocal?.username ||
          (u.user_metadata?.username as string | undefined) ||
          link?.cloudUsername ||
          u.email?.split('@')[0] ||
          'pengguna',
        email: u.email ?? currentLocal?.email,
        mode: 'cloud',
        expiresAtMs,
      });
      handlers.onTokenRefreshed?.(updated);
    }
  });

  return () => {
    listener.subscription.unsubscribe();
  };
}

export async function logoutSession(): Promise<void> {
  localStorage.removeItem(AUTH_SESSION_KEY);
  if (isSupabaseConfigured && supabase) {
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore offline signOut errors; local session is already cleared and financial data stays intact
    }
  }
}

export async function verifyPinCode(
  session: AuthSession,
  pin: string
): Promise<PinVerificationResult> {
  const storageId = resolveStorageUserId(session) ?? session.userId;
  const now = Date.now();
  const guard = getPinGuard(storageId);
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
    const u = users.find((x) => x.userId === storageId);
    storedHash = u?.pinHash ?? null;
  } else {
    const localState = loadLocalState(storageId);
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
    clearPinGuard(storageId);
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
  savePinGuard(storageId, nextGuard);

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
  const storageId = resolveStorageUserId(session) ?? session.userId;
  const localId = session.localUserId || (session.mode === 'local' ? session.userId : undefined);

  if (localId) {
    const users = readLocalUsers();
    writeLocalUsers(
      users.map((u) =>
        u.userId === localId ? { ...u, pinHash, pinEnabled, updatedAt: nowISO } : u
      )
    );
  }

  const state = loadLocalState(storageId);
  saveLocalState(
    {
      ...state,
      settings: {
        ...state.settings,
        securityPinHash: pinHash ?? undefined,
        pinEnabled,
      },
    },
    storageId
  );

  if (session.mode === 'cloud' && isSupabaseConfigured && supabase) {
    const cloudId = session.cloudUserId || session.userId;
    await supabase
      .from('profiles')
      .update({
        security_pin_hash: pinHash,
        pin_enabled: pinEnabled,
      })
      .eq('id', cloudId);
  }
}

export async function verifyAccountPassword(session: AuthSession, password: string): Promise<boolean> {
  if (!password) return false;
  if (session.mode === 'local') {
    const localId = session.localUserId || session.userId;
    const users = readLocalUsers();
    const u = users.find((x) => x.userId === localId);
    if (!u) return false;
    return verifySecretPBKDF2(password, u.passwordHash);
  }
  if (isSupabaseConfigured && supabase) {
    if (session.email) {
      const { error } = await supabase.auth.signInWithPassword({
        email: session.email,
        password,
      });
      return !error;
    }
    if (session.username) {
      const { data, error } = await supabase.functions.invoke('username-auth', {
        body: {
          action: 'login',
          username: normalizeUsername(session.username),
          password,
        },
      });
      return !error && Boolean(data?.access_token);
    }
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
  const storageId = resolveStorageUserId(session) ?? session.userId;
  clearPinGuard(storageId);
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
  const storageId = resolveStorageUserId(session) ?? session.userId;
  const localId = session.localUserId || (session.mode === 'local' ? session.userId : undefined);

  if (localId) {
    const users = readLocalUsers();
    let updatedUser: StoredLocalAuthUser | null = null;
    const nextUsers = users.map((u) => {
      if (u.userId !== localId) return u;
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
    if (!updatedUser) throw new Error('Akun pengguna tidak ditemukan.');
    writeLocalUsers(nextUsers);

    const state = loadLocalState(storageId);
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
      storageId
    );
    if (session.mode === 'local') {
      return toUserSummary(updatedUser, 'local');
    }
  }

  const state = loadLocalState(storageId);
  if (updates.pinEnabled && !state.settings.securityPinHash) {
    throw new Error('Atur PIN 6 digit terlebih dahulu sebelum mengaktifkan kunci PIN.');
  }
  const nextSettings = {
    ...state.settings,
    pinEnabled:
      updates.pinEnabled ?? state.settings.pinEnabled ?? Boolean(state.settings.securityPinHash),
    requirePinOnReopen: updates.requirePinOnReopen ?? state.settings.requirePinOnReopen ?? true,
    autoLockMinutes:
      updates.autoLockMinutes !== undefined
        ? updates.autoLockMinutes
        : state.settings.autoLockMinutes ?? 5,
  };
  saveLocalState({ ...state, settings: nextSettings }, storageId);

  if (session.mode === 'cloud' && isSupabaseConfigured && supabase) {
    const cloudId = session.cloudUserId || session.userId;
    await supabase
      .from('profiles')
      .update({
        pin_enabled: nextSettings.pinEnabled,
        require_pin_on_reopen: nextSettings.requirePinOnReopen,
        auto_lock_minutes: nextSettings.autoLockMinutes,
      })
      .eq('id', cloudId);
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
  const localId = session.localUserId || session.userId;
  const users = readLocalUsers();
  writeLocalUsers(
    users.map((u) =>
      u.userId === localId
        ? { ...u, recoveryKeyHash: newRecoveryKeyHash, updatedAt: new Date().toISOString() }
        : u
    )
  );
  return newRecoveryKey;
}

export async function requestCloudPasswordReset(usernameOrEmail: string): Promise<void> {
  if (!isSupabaseConfigured || !supabase) {
    throw new CloudAuthError(
      'Mode Cloud Supabase belum dikonfigurasi pada environment ini.',
      'CLOUD_UNAVAILABLE'
    );
  }
  const trimmed = usernameOrEmail.trim();
  if (!trimmed) throw new Error('Masukkan username atau email terdaftar.');

  const redirectTo = typeof window !== 'undefined' ? window.location.origin : undefined;

  if (!trimmed.includes('@')) {
    const normalized = normalizeUsername(trimmed);
    const { error } = await supabase.functions.invoke('username-auth', {
      body: {
        action: 'reset_password',
        identifier: normalized,
        redirectTo,
      },
    });
    if (error) {
      const status = extractHttpStatus(error);
      if (status === 429) {
        throw new CloudAuthError(
          'Terlalu banyak permintaan reset password. Silakan coba lagi beberapa saat lagi.',
          'RATE_LIMITED'
        );
      }
      throw new Error('Gagal memproses permintaan reset password.');
    }
    return;
  }

  const normalizedEmail = trimmed.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error('Format email tidak valid.');
  }
  const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
    redirectTo,
  });
  if (error) {
    const status = extractHttpStatus(error);
    if (status === 429) {
      throw new CloudAuthError(
        'Terlalu banyak permintaan reset password. Silakan coba lagi beberapa saat lagi.',
        'RATE_LIMITED'
      );
    }
    throw new Error(error.message);
  }
}
