BEGIN;

-- Admin inbox: where each message is (New, Working on, Done) and a private note
ALTER TABLE public.feedback ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new';
ALTER TABLE public.feedback DROP CONSTRAINT IF EXISTS feedback_status_check;
ALTER TABLE public.feedback ADD CONSTRAINT feedback_status_check CHECK (status IN ('new', 'working', 'done'));
ALTER TABLE public.feedback ADD COLUMN IF NOT EXISTS admin_note text CHECK (length(admin_note) <= 2000);
ALTER TABLE public.feedback ADD COLUMN IF NOT EXISTS updated_at timestamptz;
CREATE INDEX IF NOT EXISTS feedback_status_idx ON public.feedback (status, created_at DESC);

COMMIT;
