BEGIN;

-- Accounts made with "Continue with Google" have no password until they set one
ALTER TABLE public.users ALTER COLUMN password_hash DROP NOT NULL;
-- Google's stable id for the account (not the email, which can change)
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS google_sub text UNIQUE;
-- The Google address it's connected to, shown on the Account page
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS google_email text;
-- Every account keeps at least one way to sign in
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_can_sign_in;
ALTER TABLE public.users ADD CONSTRAINT users_can_sign_in CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL);

COMMIT;
