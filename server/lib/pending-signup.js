const { sql } = require('../db');
const { signToken } = require('../auth');

function studentPayload(row) {
  return {
    student_id: row.student_id,
    index_number: row.index_number,
    full_name: row.full_name,
    email: row.email || '',
    programme: row.programme || '',
    level: row.level || '',
    program: row.programme || '',
    role: 'student',
  };
}

async function purgeExpiredPending() {
  await sql`
    DELETE FROM pending_signups
    WHERE expires_at < NOW()
  `;
}

async function getPendingById(pendingId) {
  const rows = await sql`
    SELECT *
    FROM pending_signups
    WHERE pending_id = ${pendingId}
      AND expires_at > NOW()
    LIMIT 1
  `;
  return rows[0] || null;
}

/**
 * After Paystack confirms payment for a pending signup, create the real student
 * and attach the payment. Returns { student, token, payment } or null.
 */
async function finalizePendingPayment(reference, { phoneNumber, paidAt } = {}) {
  const paid = paidAt ? new Date(paidAt) : new Date();

  const payments = await sql`
    SELECT *
    FROM payments
    WHERE paystack_reference = ${reference}
    LIMIT 1
  `;
  const payment = payments[0];
  if (!payment) return null;

  // Already finalized under a student
  if (payment.student_id && payment.status === 'success') {
    const students = await sql`
      SELECT student_id, index_number, full_name, email, programme, level
      FROM students WHERE student_id = ${payment.student_id} LIMIT 1
    `;
    if (!students[0]) return { payment, student: null, token: null };
    return {
      payment,
      student: students[0],
      token: signToken({
        role: 'student',
        id: students[0].student_id,
        name: students[0].full_name,
      }),
    };
  }

  if (!payment.pending_signup_id) {
    // Existing student payment path — just mark success
    const updated = await sql`
      UPDATE payments
      SET
        status = 'success',
        paid_at = ${paid.toISOString()},
        phone_number = COALESCE(${phoneNumber || null}, phone_number)
      WHERE paystack_reference = ${reference}
      RETURNING *
    `;
    return { payment: updated[0], student: null, token: null };
  }

  const pending = await getPendingById(payment.pending_signup_id);
  if (!pending) {
    await sql`DELETE FROM payments WHERE paystack_reference = ${reference}`;
    const err = new Error('Signup expired. Register again and complete payment.');
    err.status = 410;
    throw err;
  }

  // Create student account only now that payment succeeded
  let student;
  try {
    const inserted = await sql`
      INSERT INTO students (index_number, full_name, email, password_hash, programme, level)
      VALUES (
        ${pending.index_number},
        ${pending.full_name},
        ${pending.email},
        ${pending.password_hash},
        ${pending.programme},
        ${pending.level}
      )
      RETURNING student_id, index_number, full_name, email, programme, level
    `;
    student = inserted[0];
  } catch (err) {
    if (err.code === '23505') {
      const conflict = new Error('This index or email is already registered. Sign in instead.');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }

  const updated = await sql`
    UPDATE payments
    SET
      status = 'success',
      paid_at = ${paid.toISOString()},
      phone_number = COALESCE(${phoneNumber || null}, phone_number),
      student_id = ${student.student_id},
      pending_signup_id = NULL
    WHERE paystack_reference = ${reference}
    RETURNING payment_id, email, phone_number, amount, paid_at, paystack_reference, status, student_id
  `;

  await sql`DELETE FROM pending_signups WHERE pending_id = ${pending.pending_id}`;

  const token = signToken({
    role: 'student',
    id: student.student_id,
    name: student.full_name,
  });

  return {
    payment: updated[0],
    student,
    token,
    user: studentPayload(student),
  };
}

async function cancelPendingSignup(pendingId) {
  await sql`
    DELETE FROM payments
    WHERE pending_signup_id = ${pendingId}
      AND status = 'pending'
  `;
  await sql`DELETE FROM pending_signups WHERE pending_id = ${pendingId}`;
}

module.exports = {
  studentPayload,
  purgeExpiredPending,
  getPendingById,
  finalizePendingPayment,
  cancelPendingSignup,
};
