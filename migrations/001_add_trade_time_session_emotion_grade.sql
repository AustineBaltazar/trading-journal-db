BEGIN;

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS entry_time time,
  ADD COLUMN IF NOT EXISTS exit_time  time,
  ADD COLUMN IF NOT EXISTS session    text,
  ADD COLUMN IF NOT EXISTS emotion    text,
  ADD COLUMN IF NOT EXISTS grade      text;

ALTER TABLE public.trades
  ADD CONSTRAINT trades_session_check
    CHECK (session IN ('Asian', 'London', 'New York AM', 'New York PM')),
  ADD CONSTRAINT trades_emotion_check
    CHECK (emotion IN ('Confident', 'Anxious', 'FOMO', 'Revenge', 'Calm', 'Hesitant')),
  ADD CONSTRAINT trades_grade_check
    CHECK (grade IN ('A+', 'A', 'B+', 'B', 'C+', 'C', 'D', 'F'));

COMMIT;
