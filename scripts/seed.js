const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');

const FACULTY_CODE = 'PS';
const PROGRAM_LIST = [
  { code: 'PHY', label: 'BSc Physics' },
  { code: 'CSC', label: 'BSc Computer Science' },
  { code: 'MTH', label: 'BSc Mathematics' },
  { code: 'CHM', label: 'BSc Chemistry' },
  { code: 'BIO', label: 'BSc Biology' },
  { code: 'STA', label: 'BSc Statistics' },
];

function buildIndexNumber(programCode, seq) {
  return `${FACULTY_CODE}/${programCode}/22/${String(seq).padStart(3, '0')}`;
}

/** Dedicated unpaid demo student — never gets a seeded payment. */
const UNPAID_DEMO = {
  index_number: buildIndexNumber('PHY', 101),
  full_name: 'No Payment Student',
};

function buildSeedStudents() {
  const students = [
    {
      index_number: buildIndexNumber('PHY', 1),
      full_name: 'Ama Mensah',
    },
  ];

  for (let i = 2; i <= 100; i += 1) {
    const prog = PROGRAM_LIST[(i - 2) % PROGRAM_LIST.length];
    const num = String(i).padStart(3, '0');
    students.push({
      index_number: buildIndexNumber(prog.code, i),
      full_name: `${prog.code} Student ${num}`,
    });
  }

  students.push(UNPAID_DEMO);
  return students;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in .env');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);
  const adminHash = await bcrypt.hash('admin123', 10);
  const students = buildSeedStudents();

  await sql`
    INSERT INTO admins (username, full_name, password_hash)
    VALUES ('admin', 'Physics Lab Admin', ${adminHash})
    ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
  `;

  for (const student of students) {
    await sql`
      INSERT INTO students (index_number, full_name)
      VALUES (${student.index_number}, ${student.full_name})
      ON CONFLICT (index_number) DO UPDATE
      SET full_name = EXCLUDED.full_name
    `;
  }

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

  await sql`
    INSERT INTO settings (setting_key, setting_value)
    VALUES
      ('registration_open', 'true'),
      ('practical_fee', '50')
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
  `;

  // Keep the unpaid demo student clean for payment-gate testing
  const [unpaid] = await sql`
    SELECT student_id FROM students WHERE index_number = ${UNPAID_DEMO.index_number} LIMIT 1
  `;
  if (unpaid) {
    await sql`DELETE FROM registrations WHERE student_id = ${unpaid.student_id}`;
    await sql`DELETE FROM payments WHERE student_id = ${unpaid.student_id}`;
  }

  const [count] = await sql`SELECT COUNT(*)::int AS c FROM students`;

  console.log('Seed complete.');
  console.log(`Students in database: ${count.c}`);
  console.log('Programmes: PS/PHY, PS/CSC, PS/MTH, PS/CHM, PS/BIO, PS/STA');
  console.log('Admin login: admin / admin123');
  console.log(
    `Unpaid demo (no payment): ${UNPAID_DEMO.full_name} / ${UNPAID_DEMO.index_number}`
  );
  console.log('Test flow: Autofill rotates programmes with index structure PS/PROGRAM/22/SEQ');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
