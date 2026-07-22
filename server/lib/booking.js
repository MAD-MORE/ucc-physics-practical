const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function sessionStartsAt(slotDate, startTime) {
  const date = String(slotDate || '').slice(0, 10);
  const time = String(startTime || '').slice(0, 8);
  if (!date || !time) return null;
  return new Date(`${date}T${time}`);
}

function isSessionPast(slotDate, startTime, now = new Date()) {
  const startsAt = sessionStartsAt(slotDate, startTime);
  if (!startsAt || Number.isNaN(startsAt.getTime())) return false;
  return startsAt <= now;
}

function spotsLeft(session) {
  return Math.max(0, Number(session.max_participants || 0) - Number(session.registration_count || 0));
}

function sameSession(a, b) {
  return Number(a?.schedule_id) === Number(b?.schedule_id);
}

function evaluateBookingChange({ registrationOpen, currentBooking, targetSession }) {
  if (!currentBooking) {
    return { allowed: false, reason: 'No active booking to change' };
  }
  if (!registrationOpen) {
    return { allowed: false, reason: 'Registration is closed — changes are locked' };
  }
  if (isSessionPast(currentBooking.slot_date, currentBooking.start_time)) {
    return { allowed: false, reason: 'Your session has started — changes are no longer allowed' };
  }
  if (!targetSession) {
    return { allowed: false, reason: 'Session not found' };
  }
  if (sameSession(targetSession, currentBooking)) {
    return { allowed: false, reason: 'You are already booked for this session' };
  }
  if (targetSession.schedule_status !== 'open') {
    return { allowed: false, reason: 'This session is closed' };
  }
  if (isSessionPast(targetSession.slot_date, targetSession.start_time)) {
    return { allowed: false, reason: 'This session time has passed' };
  }
  if (spotsLeft(targetSession) < 1) {
    return { allowed: false, reason: 'This session is full — no spaces left' };
  }
  return { allowed: true, reason: null };
}

function changeStateForSession({ registrationOpen, currentBooking, session }) {
  if (!currentBooking) return null;
  if (sameSession(session, currentBooking)) {
    return { state: 'current', label: 'Your session', disabled: true };
  }
  if (!registrationOpen) {
    return { state: 'locked', label: 'Changes locked', disabled: true };
  }
  if (isSessionPast(currentBooking.slot_date, currentBooking.start_time)) {
    return { state: 'locked', label: 'Time up', disabled: true };
  }
  if (session.schedule_status !== 'open') {
    return { state: 'closed', label: 'Closed', disabled: true };
  }
  if (isSessionPast(session.slot_date, session.start_time)) {
    return { state: 'past', label: 'Time up', disabled: true };
  }
  if (spotsLeft(session) < 1) {
    return { state: 'full', label: 'Full', disabled: true };
  }
  return { state: 'switch', label: 'Switch here', disabled: false };
}

module.exports = {
  DAY_ORDER,
  sessionStartsAt,
  isSessionPast,
  spotsLeft,
  evaluateBookingChange,
  changeStateForSession,
};
