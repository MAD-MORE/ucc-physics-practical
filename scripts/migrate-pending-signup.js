/**
 * Pending signup: account is only created after successful Paystack payment.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const { Pool } = require('@neondatabase/serverless');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
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
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_index_ci
        ON pending_signups (UPPER(TRIM(index_number)))
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email_ci
        ON pending_signups (LOWER(TRIM(email)))
    `);

    await client.query(`
      ALTER TABLE payments
        ALTER COLUMN student_id DROP NOT NULL
    `);

    await client.query(`
      ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS pending_signup_id INT
          REFERENCES pending_signups(pending_id) ON DELETE CASCADE
    `);

    await client.query(`
      ALTER TABLE payments
        DROP CONSTRAINT IF EXISTS payments_owner_check
    `);
    await client.query(`
      ALTER TABLE payments
        ADD CONSTRAINT payments_owner_check
        CHECK (
          (student_id IS NOT NULL AND pending_signup_id IS NULL)
          OR (student_id IS NULL AND pending_signup_id IS NOT NULL)
        )
    `);

    await client.query('COMMIT');
    console.log('pending_signups ready; payments can link to pending signup until paid.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
