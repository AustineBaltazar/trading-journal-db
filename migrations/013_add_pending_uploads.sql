BEGIN;

-- Every signed upload link handed out, until the upload is confirmed. Pending uploads
-- count toward the storage limit, and ones never confirmed are deleted from S3.
CREATE TABLE IF NOT EXISTS public.pending_uploads (
  s3_key text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_uploads_user_idx ON public.pending_uploads (user_id);
CREATE INDEX IF NOT EXISTS pending_uploads_created_idx ON public.pending_uploads (created_at);

COMMIT;
