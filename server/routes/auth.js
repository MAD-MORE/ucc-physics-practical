const express = require('express');
const bcrypt = require('bcryptjs');
const { sql } = require('../db');
const { signToken, authRequired } = require('../auth');

const router = express.Router();

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

function normalizeIndexNumber(indexNumber) {
  return String(indexNumber || '')
    .trim()
    .toUpperCase()
    .replace(/\\+/g, '/')
    .replace(/\s+/g, '');
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function studentPayload(row) {
  return {
    student_id: row.student_id,
    index_number: row.index_number,
    full_name: row.full_name,
    email: row.email || '',
    programme: row.programme || programFromIndex(row.index_number),
    level: row.level || '',
    program: row.programme || programFromIndex(row.index_number),
    role: 'student',
  };
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

router.post('/student/register', async (req, res) => {
  try {
    const fullName = String(req.body.full_name || '').trim();
    const indexNumber = normalizeIndexNumber(req.body.index_number);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const level = String(req.body.level || '').trim();
    let programme = String(req.body.programme || '').trim();

    if (!fullName || fullName.length < 2) {
      return res.status(400).json({ error: 'Enter your full name' });
    }
    if (!indexNumber || indexNumber.length < 5) {
      return res.status(400).json({ error: 'Enter a valid index number' });
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

    const passwordHash = await bcrypt.hash(password, 10);
    const rows = await sql`
      INSERT INTO students (index_number, full_name, email, password_hash, programme, level)
      VALUES (${indexNumber}, ${fullName}, ${email}, ${passwordHash}, ${programme}, ${level})
      RETURNING student_id, index_number, full_name, email, programme, level
    `;
    const student = rows[0];
    const token = signToken({ role: 'student', id: student.student_id, name: student.full_name });
    res.status(201).json({
      token,
      user: studentPayload(student),
      message: 'Account created. Continue to payment when ready.',
    });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      const detail = String(err.detail || err.constraint || err.message || '');
      if (/email/i.test(detail)) {
        return res.status(409).json({ error: 'This email is already registered. Sign in instead.' });
      }
      if (/index/i.test(detail)) {
        return res.status(409).json({ error: 'This index number is already registered. Sign in instead.' });
      }
      return res.status(409).json({ error: 'Index number or email already registered' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/student/login', async (req, res) => {
  try {
    const indexNumber = normalizeIndexNumber(req.body.index_number);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if ((!indexNumber && !email) || !password) {
      return res.status(400).json({ error: 'Index number (or email) and password are required' });
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
      return res.status(401).json({ error: 'Invalid index number or password' });
    }
    if (!student.password_hash) {
      return res.status(401).json({
        error: 'This account has no password yet. Register a new account or ask admin to reset seed data.',
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
