BEGIN;

-- One account per address: emails are stored trimmed and lowercase
UPDATE public.users SET email = lower(trim(email)) WHERE email <> lower(trim(email));
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_email_lowercase;
ALTER TABLE public.users ADD CONSTRAINT users_email_lowercase CHECK (email = lower(trim(email)));

-- Logged-in browsers. The cookie holds a random token; only its SHA-256 is stored,
-- so a database leak can't be used to log in.
CREATE TABLE IF NOT EXISTS public.sessions (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  remember boolean NOT NULL DEFAULT false,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON public.sessions (user_id);

-- Every login try, for lockouts and the login history
CREATE TABLE IF NOT EXISTS public.login_attempts (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  user_id integer REFERENCES public.users(id) ON DELETE CASCADE,
  succeeded boolean NOT NULL,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_email_idx ON public.login_attempts (email, created_at DESC);

COMMIT;
