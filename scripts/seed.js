/**
 * Production seed: admin + settings + weekly schedule slots only.
 * Does not create fake students.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in .env');
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

  const existingSchedules = await sql`SELECT schedule_id FROM schedules LIMIT 1`;
  if (existingSchedules.length === 0) {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const plan = [
      { day: 'Monday', start: '08:00', end: '10:00' },
      { day: 'Tuesday', start: '10:00', end: '12:00' },
      { day: 'Wednesday', start: '08:00', end: '10:00' },
      { day: 'Thursday', start: '12:00', end: '14:00' },
      { day: 'Friday', start: '09:00', end: '11:00' },
      { day: 'Saturday', start: '10:00', end: '12:00' },
      { day: 'Sunday', start: '14:00', end: '16:00' },
    ];

    for (const p of plan) {
      const dayIndex = days.indexOf(p.day) + 1;
      await sql`
        INSERT INTO schedules (day_of_week, slot_date, start_time, end_time, status)
        VALUES (
          ${p.day},
          CURRENT_DATE + (((${dayIndex} - EXTRACT(ISODOW FROM CURRENT_DATE)::int + 7) % 7)::int),
          ${p.start},
          ${p.end},
          'open'
        )
      `;
    }
  }

  console.log('Seed complete (admin + settings + schedules). No demo students.');
  console.log('Admin login: admin / admin123 — change this password in production.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
