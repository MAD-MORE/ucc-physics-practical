/**
 * Wipe all app data, then reseed a clean test database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const { neon } = require('@neondatabase/serverless');
const { spawnSync } = require('child_process');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);

  console.log('Clearing all data…');
  await sql`
    TRUNCATE TABLE
      registrations,
      payments,
      schedules,
      students,
      admins,
      settings
    RESTART IDENTITY CASCADE
  `;
  console.log('Database cleared.');

  console.log('Reseeding…');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'seed.js')], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  console.log('\nReady for testing.');
  console.log('Admin: admin / admin123');
  console.log('Student example: Ama Mensah / PS/PHY/22/001');
  console.log('Or use Autofill test flow on the home page.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
