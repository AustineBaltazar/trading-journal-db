BEGIN;

-- Optional one-line description and type for each Playbook rule
ALTER TABLE public.rules
  ADD COLUMN IF NOT EXISTS description text CHECK (length(description) <= 160),
  ADD COLUMN IF NOT EXISTS category text CHECK (category IN ('Entry', 'Setup', 'Risk', 'Market'));

COMMIT;
