const express = require('express');
const { sql } = require('../db');
const { authRequired } = require('../auth');
const {
  hydratePaystackEnv,
  savePaystackKeys,
  verifyPaystackKeys,
  maskKey,
} = require('../lib/paystack-config');
const { paystackConfigured, paystackMockMode } = require('../lib/paystack');

const router = express.Router();
router.use(authRequired(['admin']));

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function normalizeDay(day) {
  const match = DAYS.find((d) => d.toLowerCase() === String(day || '').trim().toLowerCase());
  return match || null;
}

function nextDateForDay(day) {
  const target = DAYS.indexOf(day) + 1;
  const today = new Date();
  const current = today.getDay() || 7;
  const diff = (target - current + 7) % 7;
  const date = new Date(today);
  date.setDate(today.getDate() + diff);
  return date.toISOString().slice(0, 10);
}

function validateParticipantLimits(minParticipants, maxParticipants) {
  return (
    Number.isInteger(minParticipants) &&
    Number.isInteger(maxParticipants) &&
    minParticipants >= 0 &&
    maxParticipants >= 1 &&
    minParticipants <= maxParticipants
  );
}

router.get('/overview', async (_req, res) => {
  try {
    const [students] = await sql`SELECT COUNT(*)::int AS c FROM students`;
    const [regs] = await sql`SELECT COUNT(*)::int AS c FROM registrations WHERE status = 'active'`;
    const [scheds] = await sql`SELECT COUNT(*)::int AS c FROM schedules`;
    const open = await sql`
      SELECT setting_value FROM settings WHERE setting_key = 'registration_open' LIMIT 1
    `;
    res.json({
      students: students.c,
      registrations: regs.c,
      schedules: scheds.c,
      registration_open: (open[0]?.setting_value || 'false') === 'true',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

router.patch('/settings/registration', async (req, res) => {
  try {
    const { open } = req.body;
    const value = open ? 'true' : 'false';
    await sql`
      INSERT INTO settings (setting_key, setting_value)
      VALUES ('registration_open', ${value})
      ON CONFLICT (setting_key) DO UPDATE
      SET setting_value = EXCLUDED.setting_value
    `;
    res.json({ registration_open: open });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

router.get('/schedules', async (_req, res) => {
  try {
    const schedules = await sql`
      SELECT
        s.*,
        (
          SELECT COUNT(*)::int
          FROM registrations r
          WHERE r.schedule_id = s.schedule_id AND r.status = 'active'
        ) AS registration_count
      FROM schedules s
      ORDER BY
        CASE s.day_of_week
          WHEN 'Monday' THEN 1
          WHEN 'Tuesday' THEN 2
          WHEN 'Wednesday' THEN 3
          WHEN 'Thursday' THEN 4
          WHEN 'Friday' THEN 5
          WHEN 'Saturday' THEN 6
          WHEN 'Sunday' THEN 7
          ELSE 8
        END,
        s.start_time
    `;
    res.json({ schedules });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load schedules' });
  }
});

router.post('/schedules', async (req, res) => {
  try {
    const {
      day_of_week,
      start_time,
      end_time,
      min_participants = 1,
      max_participants = 100,
      status = 'open',
    } = req.body;

    const day = normalizeDay(day_of_week);
    const minParticipants = Number(min_participants);
    const maxParticipants = Number(max_participants);
    if (!day || !start_time || !end_time) {
      return res.status(400).json({ error: 'day, start_time, end_time required' });
    }

    if (!validateParticipantLimits(minParticipants, maxParticipants)) {
      return res.status(400).json({
        error: 'Minimum and maximum must be whole numbers, and minimum cannot exceed maximum',
      });
    }

    if (String(end_time) <= String(start_time)) {
      return res.status(400).json({ error: 'End time must be after start time' });
    }

    const slotBusy = await sql`
      SELECT schedule_id, day_of_week, start_time, end_time
      FROM schedules
      WHERE day_of_week = ${day}
        AND start_time < ${end_time}
        AND end_time > ${start_time}
      LIMIT 1
    `;
    if (slotBusy[0]) {
      const busy = slotBusy[0];
      return res.status(409).json({
        error: `This day/time overlaps an existing slot (${busy.day_of_week} ${String(busy.start_time).slice(0, 5)}-${String(busy.end_time).slice(0, 5)})`,
      });
    }

    const created = await sql`
      INSERT INTO schedules (
        day_of_week,
        slot_date,
        start_time,
        end_time,
        min_participants,
        max_participants,
        status
      )
      VALUES (
        ${day},
        ${nextDateForDay(day)},
        ${start_time},
        ${end_time},
        ${minParticipants},
        ${maxParticipants},
        ${status === 'closed' ? 'closed' : 'open'}
      )
      RETURNING *
    `;

    res.status(201).json({ schedule: created[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Schedule conflicts with an existing booking' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create schedule' });
  }
});

router.patch('/schedules/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const day = normalizeDay(req.body.day_of_week);
    const { start_time, end_time, status } = req.body;
    const minParticipants = Number(req.body.min_participants);
    const maxParticipants = Number(req.body.max_participants);

    if (!day || !start_time || !end_time) {
      return res.status(400).json({ error: 'day, start_time, end_time required' });
    }

    if (!validateParticipantLimits(minParticipants, maxParticipants)) {
      return res.status(400).json({
        error: 'Minimum and maximum must be whole numbers, and minimum cannot exceed maximum',
      });
    }

    if (String(end_time) <= String(start_time)) {
      return res.status(400).json({ error: 'End time must be after start time' });
    }

    if (status && !['open', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'status must be open or closed' });
    }

    const existing = await sql`
      SELECT schedule_id, status
      FROM schedules
      WHERE schedule_id = ${id}
      LIMIT 1
    `;
    if (!existing[0]) return res.status(404).json({ error: 'Session not found' });

    const [current] = await sql`
      SELECT COUNT(*)::int AS registration_count
      FROM registrations
      WHERE schedule_id = ${id} AND status = 'active'
    `;
    if (maxParticipants < current.registration_count) {
      return res.status(409).json({
        error: `Maximum cannot be below the current ${current.registration_count} registrations`,
      });
    }

    const slotBusy = await sql`
      SELECT schedule_id, day_of_week, start_time, end_time
      FROM schedules
      WHERE schedule_id <> ${id}
        AND day_of_week = ${day}
        AND start_time < ${end_time}
        AND end_time > ${start_time}
      LIMIT 1
    `;
    if (slotBusy[0]) {
      const busy = slotBusy[0];
      return res.status(409).json({
        error: `This day/time overlaps an existing slot (${busy.day_of_week} ${String(busy.start_time).slice(0, 5)}-${String(busy.end_time).slice(0, 5)})`,
      });
    }

    const rows = await sql`
      UPDATE schedules
      SET
        day_of_week = ${day},
        slot_date = ${nextDateForDay(day)},
        start_time = ${start_time},
        end_time = ${end_time},
        min_participants = ${minParticipants},
        max_participants = ${maxParticipants},
        status = ${status || existing[0].status}
      WHERE schedule_id = ${id}
      RETURNING *
    `;

    res.json({ schedule: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Schedule conflicts with an existing booking' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

router.delete('/schedules/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);

    const existing = await sql`
      SELECT schedule_id
      FROM schedules
      WHERE schedule_id = ${id}
      LIMIT 1
    `;
    if (!existing[0]) return res.status(404).json({ error: 'Session not found' });

    const [current] = await sql`
      SELECT COUNT(*)::int AS registration_count
      FROM registrations
      WHERE schedule_id = ${id} AND status = 'active'
    `;
    if (current.registration_count > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${current.registration_count} student(s) registered for this session`,
      });
    }

    await sql`DELETE FROM schedules WHERE schedule_id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

router.patch('/schedules/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;
    if (!['open', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'status must be open or closed' });
    }
    const rows = await sql`
      UPDATE schedules SET status = ${status}
      WHERE schedule_id = ${id}
      RETURNING *
    `;
    if (!rows[0]) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ schedule: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

router.get('/registrations', async (_req, res) => {
  try {
    const rows = await sql`
      SELECT
        r.registration_id,
        r.registered_at,
        r.status,
        st.index_number,
        st.full_name,
        s.day_of_week,
        s.slot_date,
        s.start_time,
        s.end_time,
        p.phone_number,
        p.amount
      FROM registrations r
      JOIN students st ON st.student_id = r.student_id
      JOIN schedules s ON s.schedule_id = r.schedule_id
      JOIN payments p ON p.payment_id = r.payment_id
      WHERE r.status = 'active'
      ORDER BY r.registered_at DESC
    `;
    res.json({ registrations: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load registrations' });
  }
});

router.get('/paystack', async (_req, res) => {
  try {
    const keys = await hydratePaystackEnv(sql);
    const connected = Boolean(keys.publicKey && keys.secretKey) && !paystackMockMode();
    res.json({
      connected,
      mock: paystackMockMode(),
      mode: keys.secretKey?.includes('_live_')
        ? 'live'
        : keys.secretKey?.includes('_test_')
          ? 'test'
          : null,
      public_key_masked: maskKey(keys.publicKey),
      secret_key_masked: maskKey(keys.secretKey),
      has_public_key: Boolean(keys.publicKey),
      has_secret_key: Boolean(keys.secretKey),
      source: keys.source,
      dashboard_url: 'https://dashboard.paystack.com/#/settings/developer',
      login_url: 'https://dashboard.paystack.com/#/login',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load Paystack status' });
  }
});

router.post('/paystack/connect', async (req, res) => {
  try {
    const publicKey = String(req.body.public_key || '').trim();
    const secretKey = String(req.body.secret_key || '').trim();
    if (!publicKey || !secretKey) {
      return res.status(400).json({ error: 'Paste both Paystack public and secret keys' });
    }

    const verified = await verifyPaystackKeys(publicKey, secretKey);
    await savePaystackKeys(sql, publicKey, secretKey);

    res.json({
      connected: true,
      mock: false,
      mode: verified.mode,
      balances: verified.balances,
      public_key_masked: maskKey(publicKey),
      secret_key_masked: maskKey(secretKey),
      message: `Paystack ${verified.mode} keys connected. Student checkout will use Paystack.`,
      dashboard_url: 'https://dashboard.paystack.com/#/settings/developer',
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to connect Paystack' });
  }
});

router.post('/paystack/disconnect', async (_req, res) => {
  try {
    await savePaystackKeys(sql, '', '');
    process.env.PAYSTACK_PUBLIC_KEY = '';
    process.env.PAYSTACK_SECRET_KEY = '';
    res.json({
      connected: false,
      mock: true,
      message: 'Paystack disconnected. Add LIVE keys before taking payments.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to disconnect Paystack' });
  }
});

module.exports = router;
