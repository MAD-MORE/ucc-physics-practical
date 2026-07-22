const fs = require('fs');
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
  const file = path.join(__dirname, '..', 'db', 'schema.sql');
  const raw = fs.readFileSync(file, 'utf8');

  const cleaned = raw
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');

  const statements = cleaned
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    console.log('Dropping old tables (if present)…');
    await pool.query(`
      DROP TABLE IF EXISTS
        registrations,
        payments,
        groups,
        schedules,
        timeslots,
        experiments,
        laboratories,
        settings,
        students,
        admins
      CASCADE
    `);

    for (const statement of statements) {
      await pool.query(statement);
      const preview = statement.replace(/\s+/g, ' ').slice(0, 70);
      console.log('✓', preview + (statement.length > 70 ? '…' : ''));
    }
    console.log(`Applied ${statements.length} statements from schema.sql`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
