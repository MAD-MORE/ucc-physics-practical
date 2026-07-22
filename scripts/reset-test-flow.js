const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const { neon } = require('@neondatabase/serverless');

const TEST_INDEX = 'PS/CSC/22/003';
const TEST_NAME = 'CSC Student 003';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);
  const [student] = await sql`
    SELECT student_id FROM students WHERE index_number = ${TEST_INDEX} LIMIT 1
  `;
  if (!student) {
    console.error('Run node scripts/seed.js first.');
    process.exit(1);
  }

  await sql`DELETE FROM registrations WHERE student_id = ${student.student_id}`;
  await sql`DELETE FROM payments WHERE student_id = ${student.student_id}`;

  console.log('Test flow reset complete.');
  console.log(`${TEST_NAME} / ${TEST_INDEX} is ready for sign-in → payment → registration.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
