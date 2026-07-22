/**
 * Wipe all app data. Does not reseed.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const { neon } = require('@neondatabase/serverless');

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

  const [counts] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM students) AS students,
      (SELECT COUNT(*)::int FROM schedules) AS schedules,
      (SELECT COUNT(*)::int FROM payments) AS payments,
      (SELECT COUNT(*)::int FROM registrations) AS registrations,
      (SELECT COUNT(*)::int FROM admins) AS admins,
      (SELECT COUNT(*)::int FROM settings) AS settings
  `;

  console.log('Database is empty.');
  console.log(counts);
  console.log('Schema kept. Paystack keys in .env are unchanged.');
  console.log('Run `npm run db:seed` when you want fresh demo data.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
