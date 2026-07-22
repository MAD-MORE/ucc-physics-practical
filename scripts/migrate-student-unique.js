/**
 * Enforce no duplicate students by index or email (case-insensitive).
 * Additive — does not drop tables or payments.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const { Pool } = require('@neondatabase/serverless');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in .env');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Normalize stored values before unique indexes
    await pool.query(`
      UPDATE students
      SET index_number = UPPER(TRIM(index_number))
      WHERE index_number IS DISTINCT FROM UPPER(TRIM(index_number))
    `);
    await pool.query(`
      UPDATE students
      SET email = LOWER(TRIM(email))
      WHERE email IS NOT NULL
        AND email IS DISTINCT FROM LOWER(TRIM(email))
    `);

    // Fill blank emails so NOT NULL + UNIQUE can apply (legacy rows only)
    await pool.query(`
      UPDATE students
      SET email = 'legacy.' || student_id::text || '@pending.local'
      WHERE email IS NULL OR TRIM(email) = ''
    `);

    // If duplicate emails exist, keep the lowest student_id and rename others
    await pool.query(`
      WITH dups AS (
        SELECT student_id,
               email,
               ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(email)) ORDER BY student_id) AS rn
        FROM students
        WHERE email IS NOT NULL AND TRIM(email) <> ''
      )
      UPDATE students s
      SET email = 'dup.' || s.student_id::text || '.' || LOWER(TRIM(s.email))
      FROM dups d
      WHERE s.student_id = d.student_id AND d.rn > 1
    `);

    // If duplicate indexes exist (case variants), keep lowest id
    await pool.query(`
      WITH dups AS (
        SELECT student_id,
               ROW_NUMBER() OVER (PARTITION BY UPPER(TRIM(index_number)) ORDER BY student_id) AS rn
        FROM students
      )
      UPDATE students s
      SET index_number = UPPER(TRIM(s.index_number)) || '-DUP' || s.student_id::text
      FROM dups d
      WHERE s.student_id = d.student_id AND d.rn > 1
    `);

    await pool.query(`
      ALTER TABLE students
        ALTER COLUMN email SET NOT NULL
    `);

    await pool.query(`
      DROP INDEX IF EXISTS idx_students_email_unique;
      DROP INDEX IF EXISTS idx_students_index_unique_ci;
      DROP INDEX IF EXISTS students_email_key;
    `);

    // Case-insensitive uniqueness
    await pool.query(`
      CREATE UNIQUE INDEX idx_students_index_unique_ci
        ON students (UPPER(TRIM(index_number)))
    `);
    await pool.query(`
      CREATE UNIQUE INDEX idx_students_email_unique_ci
        ON students (LOWER(TRIM(email)))
    `);

    // Plain UNIQUE on email column as well (values already normalized)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'students_email_unique'
            AND conrelid = 'students'::regclass
        ) THEN
          ALTER TABLE students ADD CONSTRAINT students_email_unique UNIQUE (email);
        END IF;
      END $$;
    `);

    console.log('Duplicate protection enabled:');
    console.log('  - unique index_number (case-insensitive)');
    console.log('  - unique email (case-insensitive + UNIQUE constraint)');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
