/**
 * After a wipe: restore admin + portal settings only (no demo students).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);
  const adminHash = await bcrypt.hash('admin123', 10);

  await sql`
    INSERT INTO admins (username, full_name, password_hash)
    VALUES ('admin', 'Physics Lab Admin', ${adminHash})
    ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
  `;

  await sql`
    INSERT INTO settings (setting_key, setting_value)
    VALUES
      ('registration_open', 'true'),
      ('practical_fee', '50')
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
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

  console.log('Ready for live use:', counts);
  console.log('Admin: admin / admin123');
  console.log('No students, schedules, or payments. Add them in Admin.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
