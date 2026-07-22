const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'server', 'routes', 'payments.js');
let s = fs.readFileSync(file, 'utf8');

if (!s.includes('pending-signup')) {
  s = s.replace(
    "const { authRequired } = require('../auth');",
    "const { authRequired } = require('../auth');\nconst { getPendingById, finalizePendingPayment } = require('../lib/pending-signup');"
  );
}

s = s.replace(/authRequired\(\['student'\]\)/g, "authRequired(['student', 'pending'])");

const ownerHelper = `
async function resolvePaymentOwner(req) {
  if (req.user.role === 'pending') {
    const pending = await getPendingById(req.user.id);
    if (!pending) {
      const err = new Error('Signup expired. Register again and complete payment.');
      err.status = 410;
      throw err;
    }
    return {
      kind: 'pending',
      studentId: null,
      pendingId: pending.pending_id,
      email: pending.email,
      index_number: pending.index_number,
      full_name: pending.full_name,
    };
  }

  const [student] = await sql\`
    SELECT student_id, index_number, full_name, email
    FROM students
    WHERE student_id = \${req.user.id}
    LIMIT 1
  \`;
  if (!student) {
    const err = new Error('Your student session is out of date. Sign out, then sign in again.');
    err.status = 401;
    throw err;
  }
  return {
    kind: 'student',
    studentId: student.student_id,
    pendingId: null,
    email: student.email,
    index_number: student.index_number,
    full_name: student.full_name,
  };
}

async function clearOwnerPendingPayments(owner) {
  if (owner.kind === 'pending') {
    await sql\`
      DELETE FROM payments
      WHERE pending_signup_id = \${owner.pendingId}
        AND status IN ('pending', 'failed')
    \`;
    return;
  }
  await sql\`
    DELETE FROM payments
    WHERE student_id = \${owner.studentId}
      AND status IN ('pending', 'failed')
  \`;
}

`;

// Fix escaped backticks from file write — rewrite helper properly below
const helperPath = path.join(__dirname, 'pending-owner-helper.js.txt');
fs.writeFileSync(
  helperPath,
  `async function resolvePaymentOwner(req) {
  if (req.user.role === 'pending') {
    const pending = await getPendingById(req.user.id);
    if (!pending) {
      const err = new Error('Signup expired. Register again and complete payment.');
      err.status = 410;
      throw err;
    }
    return {
      kind: 'pending',
      studentId: null,
      pendingId: pending.pending_id,
      email: pending.email,
      index_number: pending.index_number,
      full_name: pending.full_name,
    };
  }

  const [student] = await sql\`
    SELECT student_id, index_number, full_name, email
    FROM students
    WHERE student_id = \${req.user.id}
    LIMIT 1
  \`;
  if (!student) {
    const err = new Error('Your student session is out of date. Sign out, then sign in again.');
    err.status = 401;
    throw err;
  }
  return {
    kind: 'student',
    studentId: student.student_id,
    pendingId: null,
    email: student.email,
    index_number: student.index_number,
    full_name: student.full_name,
  };
}

async function clearOwnerPendingPayments(owner) {
  if (owner.kind === 'pending') {
    await sql\`
      DELETE FROM payments
      WHERE pending_signup_id = \${owner.pendingId}
        AND status IN ('pending', 'failed')
    \`;
    return;
  }
  await sql\`
    DELETE FROM payments
    WHERE student_id = \${owner.studentId}
      AND status IN ('pending', 'failed')
  \`;
}
`
);

// Actually write helper with real template literals using String.raw parts
const helper = [
  'async function resolvePaymentOwner(req) {',
  "  if (req.user.role === 'pending') {",
  '    const pending = await getPendingById(req.user.id);',
  '    if (!pending) {',
  "      const err = new Error('Signup expired. Register again and complete payment.');",
  '      err.status = 410;',
  '      throw err;',
  '    }',
  '    return {',
  "      kind: 'pending',",
  '      studentId: null,',
  '      pendingId: pending.pending_id,',
  '      email: pending.email,',
  '      index_number: pending.index_number,',
  '      full_name: pending.full_name,',
  '    };',
  '  }',
  '',
  '  const [student] = await sql`',
  '    SELECT student_id, index_number, full_name, email',
  '    FROM students',
  '    WHERE student_id = ${req.user.id}',
  '    LIMIT 1',
  '  `;',
  '  if (!student) {',
  "    const err = new Error('Your student session is out of date. Sign out, then sign in again.');",
  '    err.status = 401;',
  '    throw err;',
  '  }',
  '  return {',
  "    kind: 'student',",
  '    studentId: student.student_id,',
  '    pendingId: null,',
  '    email: student.email,',
  '    index_number: student.index_number,',
  '    full_name: student.full_name,',
  '  };',
  '}',
  '',
  'async function clearOwnerPendingPayments(owner) {',
  "  if (owner.kind === 'pending') {",
  '    await sql`',
  '      DELETE FROM payments',
  '      WHERE pending_signup_id = ${owner.pendingId}',
  "        AND status IN ('pending', 'failed')",
  '    `;',
  '    return;',
  '  }',
  '  await sql`',
  '    DELETE FROM payments',
  '    WHERE student_id = ${owner.studentId}',
  "      AND status IN ('pending', 'failed')",
  '  `;',
  '}',
  '',
].join('\n');

if (!s.includes('async function resolvePaymentOwner')) {
  s = s.replace(
    '/** Declined / abandoned attempts are removed — only successful payments stay in DB. */',
    helper + '\n/** Declined / abandoned attempts are removed — only successful payments stay in DB. */'
  );
}

fs.writeFileSync(file, s);
try {
  fs.unlinkSync(helperPath);
} catch {}
console.log('payments.js helpers inserted');
