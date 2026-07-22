/**
 * Remove seeded/mock students and their payments/registrations.
 * Keeps admin, settings, schedules, and real registered students.
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

  const mockStudents = await sql`
    SELECT student_id, index_number, full_name, email
    FROM students
    WHERE
      LOWER(COALESCE(email, '')) LIKE '%@test.ucc.edu.gh'
      OR LOWER(COALESCE(email, '')) LIKE '%@pending.local'
      OR LOWER(COALESCE(email, '')) LIKE 'smoke.%@%'
      OR LOWER(COALESCE(email, '')) LIKE 'reg.%@example.com'
      OR LOWER(COALESCE(email, '')) LIKE 'dup.%'
      OR LOWER(COALESCE(full_name, '')) LIKE '% student %'
      OR LOWER(COALESCE(full_name, '')) = 'no payment student'
      OR LOWER(COALESCE(full_name, '')) LIKE 'smoke student%'
      OR LOWER(COALESCE(full_name, '')) LIKE 'reg test%'
      OR LOWER(COALESCE(full_name, '')) LIKE 'test reg%'
      OR LOWER(COALESCE(full_name, '')) LIKE 'csc student%'
      OR LOWER(COALESCE(full_name, '')) LIKE 'phy student%'
      OR LOWER(COALESCE(full_name, '')) LIKE 'mth student%'
      OR LOWER(COALESCE(full_name, '')) LIKE 'chm student%'
      OR LOWER(COALESCE(full_name, '')) LIKE 'bio student%'
      OR LOWER(COALESCE(full_name, '')) LIKE 'sta student%'
  `;

  if (!mockStudents.length) {
    console.log('No mock students found.');
    return;
  }

  const ids = mockStudents.map((s) => s.student_id);
  console.log(`Removing ${ids.length} mock student(s)…`);

  await sql`DELETE FROM registrations WHERE student_id = ANY(${ids})`;
  await sql`DELETE FROM payments WHERE student_id = ANY(${ids})`;
  await sql`DELETE FROM students WHERE student_id = ANY(${ids})`;

  const [counts] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM students) AS students,
      (SELECT COUNT(*)::int FROM payments) AS payments,
      (SELECT COUNT(*)::int FROM registrations) AS registrations
  `;
  console.log('Done.', counts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
