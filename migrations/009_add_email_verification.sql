BEGIN;

-- New accounts confirm their email before they can log in.
-- Accounts that already exist are treated as confirmed.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
UPDATE public.users SET email_verified_at = created_at WHERE email_verified_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'email_tokens');

-- One-time links sent by email. Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS public.email_tokens (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON public.email_tokens (user_id, purpose, created_at DESC);

-- Security emails sent, so the same notice isn't sent over and over
CREATE TABLE IF NOT EXISTS public.email_log (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_log_user_idx ON public.email_log (user_id, kind, created_at DESC);

COMMIT;
