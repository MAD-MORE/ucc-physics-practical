const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const { Pool } = require('@neondatabase/serverless');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in .env');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS email VARCHAR(120);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS status VARCHAR(20);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS paystack_reference VARCHAR(100);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
    `);

    await pool.query(`
      UPDATE payments
      SET email = COALESCE(NULLIF(email, ''), 'legacy@student.local')
      WHERE email IS NULL OR email = ''
    `);

    await pool.query(`
      UPDATE payments
      SET status = COALESCE(NULLIF(status, ''), 'success')
      WHERE status IS NULL OR status = ''
    `);

    await pool.query(`
      UPDATE payments
      SET paystack_reference = 'legacy-' || payment_id::text
      WHERE paystack_reference IS NULL OR paystack_reference = ''
    `);

    await pool.query(`
      UPDATE payments
      SET created_at = COALESCE(created_at, paid_at, NOW())
      WHERE created_at IS NULL
    `);

    await pool.query(`
      ALTER TABLE payments ALTER COLUMN email SET NOT NULL;
      ALTER TABLE payments ALTER COLUMN status SET DEFAULT 'pending';
      ALTER TABLE payments ALTER COLUMN status SET NOT NULL;
      ALTER TABLE payments ALTER COLUMN paystack_reference SET NOT NULL;
      ALTER TABLE payments ALTER COLUMN created_at SET DEFAULT NOW();
      ALTER TABLE payments ALTER COLUMN created_at SET NOT NULL;
    `);

    // phone_number and paid_at may remain NOT NULL from older schemas
    await pool.query(`
      DO $$
      BEGIN
        BEGIN
          ALTER TABLE payments ALTER COLUMN phone_number DROP NOT NULL;
        EXCEPTION WHEN others THEN NULL;
        END;
        BEGIN
          ALTER TABLE payments ALTER COLUMN paid_at DROP NOT NULL;
        EXCEPTION WHEN others THEN NULL;
        END;
      END $$;
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'payments_status_check'
        ) THEN
          ALTER TABLE payments
            ADD CONSTRAINT payments_status_check
            CHECK (status IN ('pending', 'success', 'failed'));
        END IF;
      END $$;
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_paystack_reference
        ON payments(paystack_reference);
    `);

    console.log('Paystack payment columns ready.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
