/**
 * Additive student auth columns — does not drop data.
 * Adds: email, password_hash, programme, level
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const { Pool } = require('@neondatabase/serverless');

const PROGRAM_LABELS = {
  PHY: 'BSc Physics',
  CSC: 'BSc Computer Science',
  MTH: 'BSc Mathematics',
  CHM: 'BSc Chemistry',
  BIO: 'BSc Biology',
  STA: 'BSc Statistics',
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in .env');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`
      ALTER TABLE students ADD COLUMN IF NOT EXISTS email VARCHAR(120);
      ALTER TABLE students ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE students ADD COLUMN IF NOT EXISTS programme VARCHAR(100);
      ALTER TABLE students ADD COLUMN IF NOT EXISTS level VARCHAR(20);
    `);

    // Backfill programme from index (PS/PHY/…) without overwriting set values
    const { rows } = await pool.query(
      `SELECT student_id, index_number, email, programme FROM students`
    );
    for (const row of rows) {
      const code = String(row.index_number || '').split('/')[1] || '';
      const programme = row.programme || PROGRAM_LABELS[code] || code || 'Undeclared';
      const email =
        row.email ||
        `student.${row.student_id}.${String(row.index_number || 'x')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '.')}@pending.local`;
      await pool.query(
        `UPDATE students
         SET programme = COALESCE(NULLIF(TRIM(programme), ''), $1),
             level = COALESCE(NULLIF(TRIM(level), ''), '200'),
             email = COALESCE(NULLIF(TRIM(email), ''), $2)
         WHERE student_id = $3`,
        [programme, email, row.student_id]
      );
    }

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_students_email_unique
        ON students (LOWER(TRIM(email)))
        WHERE email IS NOT NULL AND TRIM(email) <> '';
    `);

    console.log('Student auth columns ready (email, password_hash, programme, level).');
    console.log('Existing rows kept. Students without a password must register a new account or reset via re-seed.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
