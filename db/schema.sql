-- UCC Physics Practical Registration System (Neon / Postgres)

CREATE TABLE IF NOT EXISTS students (
  student_id    SERIAL PRIMARY KEY,
  index_number  VARCHAR(20)  NOT NULL UNIQUE,
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255),
  programme     VARCHAR(100),
  level         VARCHAR(20)
);

-- Case-insensitive uniqueness (enforced by migrate-student-unique.js on existing DBs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_index_unique_ci
  ON students (UPPER(TRIM(index_number)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_email_unique_ci
  ON students (LOWER(TRIM(email)));

CREATE TABLE IF NOT EXISTS admins (
  admin_id      SERIAL PRIMARY KEY,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  full_name     VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  setting_key   VARCHAR(50) PRIMARY KEY,
  setting_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  schedule_id      SERIAL PRIMARY KEY,
  day_of_week      VARCHAR(10) NOT NULL,
  slot_date        DATE NOT NULL,
  start_time       TIME NOT NULL,
  end_time         TIME NOT NULL,
  min_participants INT NOT NULL DEFAULT 1 CHECK (min_participants >= 0),
  max_participants INT NOT NULL DEFAULT 100 CHECK (max_participants > 0 AND max_participants >= min_participants),
  status           VARCHAR(10) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'closed')),
  CHECK (end_time > start_time)
);

CREATE TABLE IF NOT EXISTS pending_signups (
  pending_id     SERIAL PRIMARY KEY,
  index_number   VARCHAR(20)  NOT NULL,
  full_name      VARCHAR(100) NOT NULL,
  email          VARCHAR(120) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  programme      VARCHAR(100),
  level          VARCHAR(20),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_index_ci
  ON pending_signups (UPPER(TRIM(index_number)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email_ci
  ON pending_signups (LOWER(TRIM(email)));

CREATE TABLE IF NOT EXISTS payments (
  payment_id         SERIAL PRIMARY KEY,
  student_id         INT REFERENCES students(student_id) ON DELETE RESTRICT,
  pending_signup_id  INT REFERENCES pending_signups(pending_id) ON DELETE CASCADE,
  email              VARCHAR(120) NOT NULL,
  phone_number       VARCHAR(20),
  amount             NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'success', 'failed')),
  paystack_reference VARCHAR(100) NOT NULL UNIQUE,
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (student_id IS NOT NULL AND pending_signup_id IS NULL)
    OR (student_id IS NULL AND pending_signup_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS registrations (
  registration_id SERIAL PRIMARY KEY,
  student_id      INT NOT NULL REFERENCES students(student_id) ON DELETE RESTRICT,
  schedule_id     INT NOT NULL REFERENCES schedules(schedule_id) ON DELETE CASCADE,
  payment_id      INT NOT NULL UNIQUE REFERENCES payments(payment_id) ON DELETE RESTRICT,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'cancelled')),
  UNIQUE (student_id, schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_schedules_day_time ON schedules(day_of_week, start_time);
CREATE INDEX IF NOT EXISTS idx_registrations_student ON registrations(student_id);
CREATE INDEX IF NOT EXISTS idx_registrations_schedule ON registrations(schedule_id);
CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_booking_per_student
ON registrations(student_id)
WHERE status = 'active';

INSERT INTO settings (setting_key, setting_value)
VALUES
  ('registration_open', 'true'),
  ('practical_fee', '50')
ON CONFLICT (setting_key) DO NOTHING;
