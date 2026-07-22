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

router.get('/student/verify-index', async (req, res) => {
  try {
    const indexNumber = normalizeIndexNumber(req.query.index_number);
    if (!indexNumber) {
      return res.status(400).json({ error: 'Index number required' });
    }

    const rows = await sql`
      SELECT student_id, index_number, full_name
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
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Index verification failed' });
  }
});

router.post('/student/login', async (req, res) => {
  try {
    const fullName = String(req.body.full_name || '').trim();
    const indexNumber = normalizeIndexNumber(req.body.index_number);
    if (!fullName || !indexNumber) {
      return res.status(400).json({ error: 'Full name and index number required' });
    }

    const byIndex = await sql`
      SELECT student_id, index_number, full_name
      FROM students
      WHERE UPPER(TRIM(index_number)) = ${indexNumber}
      LIMIT 1
    `;
    if (!byIndex[0]) {
      return res.status(401).json({ error: 'Index number not found in the database' });
    }

    const rows = await sql`
      SELECT student_id, index_number, full_name
      FROM students
      WHERE LOWER(TRIM(full_name)) = LOWER(${fullName})
        AND UPPER(TRIM(index_number)) = ${indexNumber}
      LIMIT 1
    `;
    const student = rows[0];
    if (!student) {
      return res.status(401).json({ error: 'Name does not match this index number' });
    }

    const token = signToken({ role: 'student', id: student.student_id, name: student.full_name });
    res.json({
      token,
      user: {
        student_id: student.student_id,
        index_number: student.index_number,
        full_name: student.full_name,
        program: programFromIndex(student.index_number),
        role: 'student',
      },
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
        SELECT student_id, index_number, full_name
        FROM students WHERE student_id = ${req.user.id}
      `;
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      return res.json({
        user: {
          ...rows[0],
          program: programFromIndex(rows[0].index_number),
          role: 'student',
        },
      });
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
