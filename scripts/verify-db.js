const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const { neon } = require('@neondatabase/serverless');

async function main() {
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`SELECT 1 AS ok, current_database() AS db`;
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `;
  console.log('VERIFY', JSON.stringify(rows[0]));
  console.log('TABLES', tables.map((t) => t.table_name).join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
