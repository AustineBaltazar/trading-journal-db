BEGIN;

-- When the account accepted the Terms and Privacy policy (sign-ups from now on)
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

-- Bug reports and ideas from the in-app feedback button
CREATE TABLE IF NOT EXISTS public.feedback (
  id bigserial PRIMARY KEY,
  user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('bug', 'idea', 'other')),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  page text CHECK (length(page) <= 200),
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_user_idx ON public.feedback (user_id, created_at DESC);

COMMIT;
