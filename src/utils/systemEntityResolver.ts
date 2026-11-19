import { SYSTEM_ACCOUNT_KEY_MAP, SYSTEM_CATEGORY_KEY_MAP } from '../data/initialProfile';
import { Account, Category } from '../types/finance';

export interface SystemLookupOptions {
  activeOnly?: boolean;
}

export function findSystemAccount(
  accounts: readonly Account[],
  systemKey: string,
  legacyId?: string,
  options?: SystemLookupOptions
): Account | undefined {
  const activeOnly = options?.activeOnly ?? false;
  const pool = activeOnly
    ? accounts.filter((a) => (a.status ?? 'active') === 'active')
    : accounts;

  const byKey = pool.find((a) => a.systemKey === systemKey);
  if (byKey) return byKey;

  if (legacyId) {
    const byLegacyId = pool.find((a) => a.id === legacyId);
    if (byLegacyId) return byLegacyId;
  }

  return undefined;
}

export function resolveSystemAccountId(
  accounts: readonly Account[],
  systemKey: string,
  legacyId: string,
  fallbackId?: string,
  options?: SystemLookupOptions
): string {
  const matched = findSystemAccount(accounts, systemKey, legacyId, options);
  if (matched) return matched.id;
  if (options?.activeOnly) {
    const anyMatched = findSystemAccount(accounts, systemKey, legacyId, { activeOnly: false });
    if (anyMatched) return anyMatched.id;
  }
  return fallbackId ?? accounts[0]?.id ?? legacyId;
}

export function findSystemCategory(
  categories: readonly Category[],
  systemKey: string,
  legacyId?: string
): Category | undefined {
  const byKey = categories.find((c) => c.systemKey === systemKey);
  if (byKey) return byKey;

  if (legacyId) {
    const byLegacyId = categories.find((c) => c.id === legacyId);
    if (byLegacyId) return byLegacyId;
  }

  return undefined;
}

export function resolveSystemCategoryId(
  categories: readonly Category[],
  systemKey: string,
  legacyId: string,
  fallbackType?: Category['type']
): string {
  const matched = findSystemCategory(categories, systemKey, legacyId);
  if (matched) return matched.id;
  if (fallbackType) {
    const byType = categories.find((c) => c.type === fallbackType && !c.isArchived);
    if (byType) return byType.id;
  }
  return legacyId;
}

export function resolveCategorySystemKey(
  categoryId: string | undefined,
  categories: readonly Category[]
): string | undefined {
  if (!categoryId) return undefined;
  const cat = categories.find((c) => c.id === categoryId);
  if (cat?.systemKey) return cat.systemKey;
  return SYSTEM_CATEGORY_KEY_MAP[categoryId];
}

export function matchesCategorySystemKey(
  categoryId: string | undefined,
  categories: readonly Category[],
  systemKey: string,
  legacyId?: string
): boolean {
  if (!categoryId) return false;
  const resolved = resolveCategorySystemKey(categoryId, categories);
  if (resolved) return resolved === systemKey;
  return legacyId ? categoryId === legacyId : false;
}

export function resolveAccountSystemKey(
  accountId: string | undefined,
  accounts: readonly Account[]
): string | undefined {
  if (!accountId) return undefined;
  const acc = accounts.find((a) => a.id === accountId);
  if (acc?.systemKey) return acc.systemKey;
  return SYSTEM_ACCOUNT_KEY_MAP[accountId];
}

export interface CategorySystemKeyLookup {
  getKey(categoryId: string | undefined): string | undefined;
  isKey(categoryId: string | undefined, systemKey: string): boolean;
}

export function buildCategorySystemKeyLookup(
  categories: readonly Category[]
): CategorySystemKeyLookup {
  const idToSystemKey = new Map<string, string>();
  for (const cat of categories) {
    const key = cat.systemKey ?? SYSTEM_CATEGORY_KEY_MAP[cat.id];
    if (key) {
      idToSystemKey.set(cat.id, key);
    }
  }
  return {
    getKey(categoryId: string | undefined): string | undefined {
      if (!categoryId) return undefined;
      return idToSystemKey.get(categoryId) ?? SYSTEM_CATEGORY_KEY_MAP[categoryId];
    },
    isKey(categoryId: string | undefined, systemKey: string): boolean {
      if (!categoryId) return false;
      const key = idToSystemKey.get(categoryId) ?? SYSTEM_CATEGORY_KEY_MAP[categoryId];
      return key === systemKey;
    },
  };
}
