const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });

const BASE = process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

async function request(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
  ...options,
  headers: {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  },
  body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function main() {
  console.log(`Smoke test → ${BASE}`);

  const health = await request('/api/health');
  if (!health.ok || !health.db) throw new Error('Health check failed');

  const admin = await request('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
  });
  const adminHeaders = { Authorization: `Bearer ${admin.token}` };

  const overview = await request('/api/admin/overview', { headers: adminHeaders });
  if (!overview.schedules) throw new Error('Admin overview missing schedules');

  const suffix = Date.now();
  const indexNumber = `PS/CSC/22/${String(900 + (suffix % 90)).padStart(3, '0')}`;
  const email = `smoke.${suffix}@test.ucc.edu.gh`;
  const password = 'smoke-pass-123';

  const registered = await request('/api/auth/student/register', {
    method: 'POST',
    body: {
      full_name: `Smoke Student ${suffix}`,
      index_number: indexNumber,
      level: '200',
      programme: 'BSc Computer Science',
      email,
      password,
    },
  });
  if (!registered.token) throw new Error('Student register failed');

  const studentLogin = await request('/api/auth/student/login', {
    method: 'POST',
    body: {
      index_number: indexNumber,
      password,
    },
  });
  const studentHeaders = { Authorization: `Bearer ${studentLogin.token}` };

  const sessions = await request('/api/student/sessions', { headers: studentHeaders });
  if (!sessions.sessions?.length) throw new Error('No demo sessions available');

  if (!sessions.unused_payment && !sessions.has_booking) {
    const paid = await request('/api/student/payments/initialize', {
      method: 'POST',
      headers: studentHeaders,
      body: {
        email: `smoke.${suffix}@test.ucc.edu.gh`,
        phone_number: '0244999099',
      },
    });
    if (paid.mock || paid.already_paid || paid.payment) {
      // mock debit or already paid — fine for smoke
    } else if (paid.access_code || paid.authorization_url) {
      console.log('Paystack live initialize OK (skipping popup in smoke test)');
      // Cannot complete Popup in headless smoke — stop before register if unpaid
      console.log('Smoke test: payment requires Paystack Popup; skipping booking steps.');
      console.log('OK - health, admin, student login, Paystack initialize');
      return;
    } else {
      throw new Error('Payment initialize returned an unexpected payload');
    }
  }

  if (!sessions.has_booking) {
    const openSession =
      sessions.sessions.find((s) => s.schedule_status === 'open' && (s.spots_left ?? 1) > 0) ||
      sessions.sessions[0];
    const scheduleId = openSession?.schedule_id;
    if (!scheduleId) throw new Error('No open demo sessions');

    const reg = await request('/api/student/register', {
      method: 'POST',
      headers: studentHeaders,
      body: { schedule_id: scheduleId },
    });
    if (!reg.registration?.registration_id) throw new Error('Registration failed');
  }

  const afterBook = await request('/api/student/sessions', { headers: studentHeaders });
  const switchTarget = afterBook.sessions.find(
    (s) => s.change?.state === 'switch' && s.schedule_id !== afterBook.current_booking?.schedule_id
  );
  if (switchTarget && afterBook.can_change_booking) {
    const changed = await request('/api/student/booking', {
      method: 'PATCH',
      headers: studentHeaders,
      body: { schedule_id: switchTarget.schedule_id },
    });
    if (!changed.registration?.registration_id) throw new Error('Booking change failed');
  }

  const regs = await request('/api/student/registrations', { headers: studentHeaders });
  if (!regs.registrations?.length) throw new Error('Student registrations empty after booking');

  console.log('OK - health, admin, student login, payment, registration, booking change');
}

main().catch((err) => {
  console.error('FAIL —', err.message);
  if (err.data) console.error(err.data);
  process.exit(1);
});
