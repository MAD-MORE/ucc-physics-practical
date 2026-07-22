const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sql } = require('../db');
const { signToken, authRequired } = require('../auth');
const {
  normalizeIndexNumber,
  isValidIndexNumber,
  indexFormatError,
} = require('../lib/index-number');
const {
  studentPayload,
  purgeExpiredPending,
  cancelPendingSignup,
} = require('../lib/pending-signup');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const PROGRAM_LABELS = {
  PHY: 'BSc Physics',
  CSC: 'BSc Computer Science',
  MTH: 'BSc Mathematics',
  CHM: 'BSc Chemistry',
  BIO: 'BSc Biology',
  STA: 'BSc Statistics',
};

const ALLOWED_LEVELS = new Set(['100', '200', '300', '400']);
const ALLOWED_PROGRAMMES = new Set(Object.values(PROGRAM_LABELS));

function programFromIndex(indexNumber) {
  const code = String(indexNumber || '').split('/')[1] || '';
  return PROGRAM_LABELS[code] || code || 'Unknown programme';
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function signPendingToken(pending) {
  return jwt.sign(
    {
      role: 'pending',
      id: pending.pending_id,
      name: pending.full_name,
      email: pending.email,
      index_number: pending.index_number,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

router.get('/student/verify-index', async (req, res) => {
  try {
    const indexNumber = normalizeIndexNumber(req.query.index_number);
    if (!indexNumber) {
      return res.status(400).json({ error: 'Index number required' });
    }

    const rows = await sql`
      SELECT student_id, index_number, full_name, email
      FROM students
      WHERE UPPER(TRIM(index_number)) = ${indexNumber}
      LIMIT 1
    `;

    if (!rows[0]) {
      return res.json({ exists: false });
    }

    res.json({
      exists: true,
      student: {
        index_number: rows[0].index_number,
        full_name: rows[0].full_name,
        email: rows[0].email || '',
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Index verification failed' });
  }
});

/**
 * Start signup — does NOT create a student row.
 * Account is created only after Paystack payment succeeds.
 */
router.post('/student/register', async (req, res) => {
  try {
    await purgeExpiredPending();

    const fullName = String(req.body.full_name || '').trim();
    const indexNumber = normalizeIndexNumber(req.body.index_number);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const level = String(req.body.level || '').trim();
    let programme = String(req.body.programme || '').trim();

    if (!fullName || fullName.length < 2) {
      return res.status(400).json({ error: 'Enter your full name' });
    }
    if (!isValidIndexNumber(indexNumber)) {
      return res.status(400).json({ error: indexFormatError() });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (!ALLOWED_LEVELS.has(level)) {
      return res.status(400).json({ error: 'Select a valid level (100–400)' });
    }
    if (!programme) {
      programme = programFromIndex(indexNumber);
    }
    if (!ALLOWED_PROGRAMMES.has(programme)) {
      return res.status(400).json({ error: 'Select a valid programme' });
    }

    const existingIndex = await sql`
      SELECT student_id FROM students
      WHERE UPPER(TRIM(index_number)) = ${indexNumber}
      LIMIT 1
    `;
    if (existingIndex[0]) {
      return res.status(409).json({ error: 'This index number is already registered. Sign in instead.' });
    }

    const existingEmail = await sql`
      SELECT student_id FROM students
      WHERE LOWER(TRIM(email)) = ${email}
      LIMIT 1
    `;
    if (existingEmail[0]) {
      return res.status(409).json({ error: 'This email is already registered. Sign in instead.' });
    }

    // Replace any previous unfinished signup for this index/email
    await sql`
      DELETE FROM pending_signups
      WHERE UPPER(TRIM(index_number)) = ${indexNumber}
         OR LOWER(TRIM(email)) = ${email}
    `;

    const passwordHash = await bcrypt.hash(password, 10);
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    const rows = await sql`
      INSERT INTO pending_signups (
        index_number, full_name, email, password_hash, programme, level, expires_at
      )
      VALUES (
        ${indexNumber},
        ${fullName},
        ${email},
        ${passwordHash},
        ${programme},
        ${level},
        ${expires.toISOString()}
      )
      RETURNING pending_id, index_number, full_name, email, programme, level, expires_at
    `;
    const pending = rows[0];
    const token = signPendingToken(pending);

    res.status(201).json({
      token,
      requires_payment: true,
      user: {
        role: 'pending',
        pending_id: pending.pending_id,
        index_number: pending.index_number,
        full_name: pending.full_name,
        email: pending.email,
        programme: pending.programme,
        level: pending.level,
      },
      message: 'Pay the practical fee to create your account. Nothing is saved for sign-in until payment succeeds.',
    });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This index or email already has an unfinished signup. Complete payment or try again.' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

/** Cancel unfinished signup — removes pending data (no student account). */
router.post('/student/cancel-pending', authRequired(['pending']), async (req, res) => {
  try {
    await cancelPendingSignup(req.user.id);
    res.json({ ok: true, message: 'Signup cancelled. No account was created.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not cancel signup' });
  }
});

router.post('/student/login', async (req, res) => {
  try {
    await purgeExpiredPending();

    const indexNumber = normalizeIndexNumber(req.body.index_number);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if ((!indexNumber && !email) || !password) {
      return res.status(400).json({ error: 'Index number (or email) and password are required' });
    }
    if (indexNumber && !isValidIndexNumber(indexNumber)) {
      return res.status(400).json({ error: indexFormatError() });
    }

    const rows = indexNumber
      ? await sql`
          SELECT student_id, index_number, full_name, email, password_hash, programme, level
          FROM students
          WHERE UPPER(TRIM(index_number)) = ${indexNumber}
          LIMIT 1
        `
      : await sql`
          SELECT student_id, index_number, full_name, email, password_hash, programme, level
          FROM students
          WHERE LOWER(TRIM(email)) = ${email}
          LIMIT 1
        `;

    const student = rows[0];
    if (!student) {
      // Unpaid signup is not a login account
      const pending = indexNumber
        ? await sql`
            SELECT pending_id FROM pending_signups
            WHERE UPPER(TRIM(index_number)) = ${indexNumber}
              AND expires_at > NOW()
            LIMIT 1
          `
        : await sql`
            SELECT pending_id FROM pending_signups
            WHERE LOWER(TRIM(email)) = ${email}
              AND expires_at > NOW()
            LIMIT 1
          `;
      if (pending[0]) {
        return res.status(401).json({
          error: 'Payment not completed. Create account again and finish Paystack payment before you can sign in.',
        });
      }
      return res.status(401).json({ error: 'Invalid index number or password' });
    }
    if (!student.password_hash) {
      return res.status(401).json({
        error: 'This account has no password yet. Register again and complete payment.',
      });
    }
    if (!(await bcrypt.compare(password, student.password_hash))) {
      return res.status(401).json({ error: 'Invalid index number or password' });
    }

    const token = signToken({ role: 'student', id: student.student_id, name: student.full_name });
    res.json({
      token,
      user: studentPayload(student),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const rows = await sql`
      SELECT * FROM admins WHERE username = ${username.trim()} LIMIT 1
    `;
    const admin = rows[0];
    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = signToken({ role: 'admin', id: admin.admin_id, name: admin.full_name });
    res.json({
      token,
      user: {
        admin_id: admin.admin_id,
        username: admin.username,
        full_name: admin.full_name,
        role: 'admin',
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', authRequired(), async (req, res) => {
  try {
    if (req.user.role === 'pending') {
      const rows = await sql`
        SELECT pending_id, index_number, full_name, email, programme, level
        FROM pending_signups
        WHERE pending_id = ${req.user.id}
          AND expires_at > NOW()
        LIMIT 1
      `;
      if (!rows[0]) return res.status(404).json({ error: 'Signup expired. Register again.' });
      return res.json({
        user: {
          role: 'pending',
          pending_id: rows[0].pending_id,
          index_number: rows[0].index_number,
          full_name: rows[0].full_name,
          email: rows[0].email,
          programme: rows[0].programme,
          level: rows[0].level,
        },
        requires_payment: true,
      });
    }
    if (req.user.role === 'student') {
      const rows = await sql`
        SELECT student_id, index_number, full_name, email, programme, level
        FROM students WHERE student_id = ${req.user.id}
      `;
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      return res.json({ user: studentPayload(rows[0]) });
    }
    const rows = await sql`
      SELECT admin_id, username, full_name FROM admins WHERE admin_id = ${req.user.id}
    `;
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: { ...rows[0], role: 'admin' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

module.exports = router;
