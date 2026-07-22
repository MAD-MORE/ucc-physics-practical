-- UCC Physics Practical Registration System (Neon / Postgres)

CREATE TABLE IF NOT EXISTS students (
  student_id   SERIAL PRIMARY KEY,
  index_number VARCHAR(20)  NOT NULL UNIQUE,
  full_name    VARCHAR(100) NOT NULL
);

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

CREATE TABLE IF NOT EXISTS payments (
  payment_id         SERIAL PRIMARY KEY,
  student_id         INT NOT NULL REFERENCES students(student_id) ON DELETE RESTRICT,
  email              VARCHAR(120) NOT NULL,
  phone_number       VARCHAR(20),
  amount             NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'success', 'failed')),
  paystack_reference VARCHAR(100) NOT NULL UNIQUE,
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
