const express = require('express');
const { sql } = require('../db');
const { authRequired } = require('../auth');
const { getPortalSettings } = require('../lib/portal');
const {
  isSessionPast,
  spotsLeft,
  evaluateBookingChange,
  changeStateForSession,
} = require('../lib/booking');

const router = express.Router();

function formatTimeLabel(t) {
  return String(t || '').slice(0, 5);
}

async function getCurrentBooking(studentId) {
  const rows = await sql`
    SELECT
      r.registration_id,
      r.schedule_id,
      r.payment_id,
      s.day_of_week,
      s.slot_date,
      s.start_time,
      s.end_time
    FROM registrations r
    JOIN schedules s ON s.schedule_id = r.schedule_id
    WHERE r.student_id = ${studentId} AND r.status = 'active'
    LIMIT 1
  `;
  return rows[0] || null;
}

async function getSession(scheduleId) {
  const rows = await sql`
    SELECT
      s.schedule_id,
      s.status AS schedule_status,
      s.max_participants,
      s.day_of_week,
      s.slot_date,
      s.start_time,
      s.end_time,
      (
        SELECT COUNT(*)::int
        FROM registrations r
        WHERE r.schedule_id = s.schedule_id AND r.status = 'active'
      ) AS registration_count
    FROM schedules s
    WHERE s.schedule_id = ${scheduleId}
    LIMIT 1
  `;
  return rows[0] || null;
}

router.use(authRequired(['student']));

router.get('/sessions', async (req, res) => {
  try {
    const portal = await getPortalSettings(sql);
    const currentBooking = await getCurrentBooking(req.user.id);

    const unusedPayments = await sql`
      SELECT payment_id, email, phone_number, amount, paid_at, paystack_reference, status
      FROM payments
      WHERE student_id = ${req.user.id}
        AND status = 'success'
        AND payment_id NOT IN (SELECT payment_id FROM registrations)
      ORDER BY paid_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `;

    const sessions = await sql`
      SELECT
        s.schedule_id,
        s.status AS schedule_status,
        s.max_participants,
        s.day_of_week,
        s.slot_date,
        s.start_time,
        s.end_time,
        (
          SELECT COUNT(*)::int
          FROM registrations r
          WHERE r.schedule_id = s.schedule_id AND r.status = 'active'
        ) AS registration_count
      FROM schedules s
      WHERE s.status = 'open'
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

    const canChange =
      Boolean(currentBooking) &&
      portal.registration_open &&
      !isSessionPast(currentBooking.slot_date, currentBooking.start_time);

    const sessionsWithChange = sessions.map((session) => ({
      ...session,
      spots_left: spotsLeft(session),
      change: currentBooking
        ? changeStateForSession({
            registrationOpen: portal.registration_open,
            currentBooking,
            session,
          })
        : null,
    }));

    res.json({
      registration_open: portal.registration_open,
      open_session_count: portal.open_session_count,
      has_booking: Boolean(currentBooking),
      can_change_booking: canChange,
      current_booking: currentBooking
        ? {
            ...currentBooking,
            can_change: canChange,
            blocked_reason: canChange
              ? null
              : !portal.registration_open
                ? 'Registration is closed'
                : 'Your session time has passed',
          }
        : null,
      fee: portal.fee,
      unused_payment: unusedPayments[0] || null,
      sessions: sessionsWithChange,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

router.get('/registrations', async (req, res) => {
  try {
    const rows = await sql`
      SELECT
        r.registration_id,
        r.registered_at,
        r.status,
        s.day_of_week,
        s.slot_date,
        s.start_time,
        s.end_time,
        p.phone_number,
        p.amount
      FROM registrations r
      JOIN schedules s ON s.schedule_id = r.schedule_id
      JOIN payments p ON p.payment_id = r.payment_id
      WHERE r.student_id = ${req.user.id}
      ORDER BY r.registered_at DESC
    `;
    res.json({ registrations: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load registrations' });
  }
});

router.post('/register', async (req, res) => {
  try {
    const scheduleId = Number(req.body.schedule_id);
    if (!scheduleId) {
      return res.status(400).json({ error: 'schedule_id is required' });
    }

    const portal = await getPortalSettings(sql);
    if (!portal.registration_open) {
      return res.status(403).json({ error: 'Registration is currently closed' });
    }

    const existingBooking = await getCurrentBooking(req.user.id);
    if (existingBooking) {
      return res.status(409).json({ error: 'Only one booking is allowed per student' });
    }

    const payments = await sql`
      SELECT payment_id FROM payments
      WHERE student_id = ${req.user.id}
        AND status = 'success'
        AND payment_id NOT IN (SELECT payment_id FROM registrations)
      ORDER BY paid_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `;
    if (!payments[0]) {
      return res.status(402).json({ error: 'Complete Paystack payment before registering' });
    }
    const paymentId = payments[0].payment_id;

    const session = await getSession(scheduleId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.schedule_status !== 'open') {
      return res.status(400).json({ error: 'This session is closed' });
    }
    if (isSessionPast(session.slot_date, session.start_time)) {
      return res.status(409).json({ error: 'This session time has passed' });
    }
    if (spotsLeft(session) < 1) {
      return res.status(409).json({ error: 'This session has reached its maximum number of people' });
    }

    try {
      const reg = await sql`
        INSERT INTO registrations (student_id, schedule_id, payment_id, status)
        VALUES (${req.user.id}, ${scheduleId}, ${paymentId}, 'active')
        RETURNING *
      `;
      return res.status(201).json({
        registration: reg[0],
        message: `Registered for ${session.day_of_week}, ${formatTimeLabel(session.start_time)}-${formatTimeLabel(session.end_time)}`,
      });
    } catch (insertErr) {
      if (insertErr.code === '23505') {
        return res.status(409).json({ error: 'Only one booking is allowed per student' });
      }
      throw insertErr;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.patch('/booking', async (req, res) => {
  try {
    const scheduleId = Number(req.body.schedule_id);
    if (!scheduleId) {
      return res.status(400).json({ error: 'schedule_id is required' });
    }

    const portal = await getPortalSettings(sql);
    const currentBooking = await getCurrentBooking(req.user.id);
    if (!currentBooking) {
      return res.status(404).json({ error: 'No active booking to change' });
    }

    const targetSession = await getSession(scheduleId);
    const decision = evaluateBookingChange({
      registrationOpen: portal.registration_open,
      currentBooking,
      targetSession,
    });
    if (!decision.allowed) {
      return res.status(409).json({ error: decision.reason });
    }

    const oldScheduleId = currentBooking.schedule_id;
    const newScheduleId = scheduleId;

    const [capacity] = await sql`
      SELECT
        max_participants,
        (
          SELECT COUNT(*)::int
          FROM registrations r
          WHERE r.schedule_id = schedules.schedule_id
            AND r.status = 'active'
            AND r.registration_id <> ${currentBooking.registration_id}
        ) AS other_count
      FROM schedules
      WHERE schedule_id = ${newScheduleId}
        AND status = 'open'
      LIMIT 1
    `;
    if (!capacity || capacity.other_count >= capacity.max_participants) {
      return res.status(409).json({
        error: 'Booking change failed — the session may have filled up. Refresh and try another slot.',
      });
    }

    const rows = await sql`
      UPDATE registrations
      SET schedule_id = ${newScheduleId}
      WHERE registration_id = ${currentBooking.registration_id}
        AND student_id = ${req.user.id}
        AND status = 'active'
        AND schedule_id = ${oldScheduleId}
      RETURNING *
    `;
    if (!rows[0]) {
      return res.status(409).json({
        error: 'Booking change failed — please refresh and try again',
      });
    }

    const refreshed = await getSession(newScheduleId);
    return res.json({
      registration: rows[0],
      message: `Booking changed to ${refreshed.day_of_week}, ${formatTimeLabel(refreshed.start_time)}-${formatTimeLabel(refreshed.end_time)}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Booking change failed' });
  }
});

module.exports = router;
