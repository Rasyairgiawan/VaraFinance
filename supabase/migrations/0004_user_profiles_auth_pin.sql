-- Migration 0004: Username uniqueness, PIN quick-unlock & session security preferences

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username TEXT,
  ADD COLUMN IF NOT EXISTS username_normalized TEXT GENERATED ALWAYS AS (
    CASE WHEN username IS NULL THEN NULL ELSE pg_catalog.lower(pg_catalog.btrim(username)) END
  ) STORED,
  ADD COLUMN IF NOT EXISTS recovery_email TEXT,
  ADD COLUMN IF NOT EXISTS pin_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS require_pin_on_reopen BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_lock_minutes INTEGER NOT NULL DEFAULT 5 CHECK (auto_lock_minutes >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_lower
  ON public.profiles (lower(username))
  WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_normalized
  ON public.profiles (username_normalized)
  WHERE username_normalized IS NOT NULL;

-- Ensure RLS remains enabled on profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Remove legacy insecure RPC that exposed recovery_email to anon/authenticated
DROP FUNCTION IF EXISTS public.resolve_login_email(TEXT);

-- Hardened RPC for authenticated/service_role username availability check
-- Note: Revoked from PUBLIC and anon to prevent unauthenticated username enumeration.
-- Unauthenticated pre-signup availability checks are routed through the server-side Edge Function.
CREATE OR REPLACE FUNCTION public.is_username_available(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_username IS NULL OR pg_catalog.btrim(p_username) !~ '^[A-Za-z0-9._]{3,24}$' THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE pg_catalog.lower(username) = pg_catalog.lower(pg_catalog.btrim(p_username))
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.is_username_available(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_username_available(TEXT) TO authenticated, service_role;

-- Internal schema (not exposed via PostgREST) for server-side Edge Function username -> user_id resolution.
-- Never returns recovery_email; exclusively executable by service_role.
CREATE SCHEMA IF NOT EXISTS private_auth;
REVOKE ALL ON SCHEMA private_auth FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private_auth TO service_role;

CREATE OR REPLACE FUNCTION private_auth.get_user_id_by_username(p_username TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.id
  FROM public.profiles AS p
  WHERE p_username IS NOT NULL
    AND pg_catalog.btrim(p_username) ~ '^[A-Za-z0-9._]{3,24}$'
    AND pg_catalog.lower(p.username) = pg_catalog.lower(pg_catalog.btrim(p_username))
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION private_auth.get_user_id_by_username(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private_auth.get_user_id_by_username(TEXT) TO service_role;
