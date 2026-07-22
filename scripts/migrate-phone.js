const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const { neon } = require('@neondatabase/serverless');

async function main() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20)`;
  console.log('payments.phone_number ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
