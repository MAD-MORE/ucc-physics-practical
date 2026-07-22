/**
 * Mock data for testing — rotates real seeded students (same rules as scripts/seed.js).
 */
let nextTestStudentNum = 101;

function nextTestStudent() {
  const seq = nextTestStudentNum;
  // Prefer unpaid demo first, then rotate 1–100
  if (nextTestStudentNum === 101) nextTestStudentNum = 1;
  else {
    nextTestStudentNum += 1;
    if (nextTestStudentNum > 100) nextTestStudentNum = 101;
  }

  SEED.student = seededStudentBySeq(seq);
  return SEED.student;
}

const SEED = {
  admin: {
    username: 'admin',
    password: 'admin123',
    full_name: 'Physics Lab Admin',
  },
  student: null,
  fee: 50,
  schedule: {
    day_of_week: 'Monday',
    start_time: '08:00',
    end_time: '10:00',
    min_participants: 5,
    max_participants: 30,
  },
};

const DEMO = {
  get student() {
    return SEED.student;
  },
  admin: SEED.admin,
  schedule: SEED.schedule,
};

function setFieldValue(id, value) {
  const el = document.getElementById(id);
  if (el && value != null) el.value = value;
}

function autofillStudentLogin() {
  const student = nextTestStudent();
  setFieldValue('student-name', student.full_name);
  setFieldValue('student-index', student.index_number);
  renderMockFlowPanel();
  return student;
}

function autofillAdminLogin() {
  setFieldValue('admin-username', SEED.admin.username);
  setFieldValue('admin-password', SEED.admin.password);
}

function autofillMomo() {
  if (!SEED.student) nextTestStudent();
  setFieldValue('modal-email', SEED.student.email);
  // Prefer the student’s demo phone; for Paystack TEST keys only, use official test MoMo
  const form = document.querySelector('[data-paystack-form]');
  const testKeys = form?.dataset?.paystackPublicKey?.includes('_test_');
  setFieldValue('modal-phone', testKeys ? '0551234987' : SEED.student.phone_number);
  setFieldValue('modal-provider', 'mtn');
  const momoRadio = document.querySelector('input[name="pay_method"][value="momo"]');
  if (momoRadio) momoRadio.checked = true;
}

function autofillModalMomo() {
  autofillMomo();
}

function autofillSchedule() {
  setFieldValue('sch-day', SEED.schedule.day_of_week);
  setFieldValue('sch-start', SEED.schedule.start_time);
  setFieldValue('sch-end', SEED.schedule.end_time);
  setFieldValue('sch-min', SEED.schedule.min_participants);
  setFieldValue('sch-max', SEED.schedule.max_participants);
}

function renderMockFlowPanel(containerId = 'mock-flow-panel') {
  const el = document.getElementById(containerId);
  if (!el) return;

  const student = SEED.student;
  const studentBlock = student
    ? `
    <div class="mock-flow-grid">
      <div><span class="meta">Programme</span><strong>${escapeHtml(student.program_group || programGroupFromIndex(student.index_number))}</strong></div>
      <div><span class="meta">Full name</span><strong>${escapeHtml(student.full_name)}</strong></div>
      <div><span class="meta">Index number</span><strong>${escapeHtml(student.index_number)}</strong></div>
      <div><span class="meta">Email</span><strong>${escapeHtml(student.email)}</strong></div>
      <div><span class="meta">MoMo phone</span><strong>${escapeHtml(student.phone_number)}</strong></div>
    </div>`
    : `<p class="meta">Click <strong>Autofill test flow</strong> to load a fresh seeded student.</p>`;

  el.innerHTML = `
    <h3 style="font-family:var(--font-display);font-weight:400;color:var(--teal-deep);margin:0 0 0.5rem;">
      Test flow mock data
    </h3>
    <p class="lede" style="margin-bottom:0.75rem;">
      First autofill is the unpaid demo (<strong>No Payment Student</strong> / <strong>PS/PHY/22/101</strong>), then programmes rotate: PS/PHY, PS/CSC, PS/MTH, PS/CHM, PS/BIO, PS/STA.
    </p>
    ${studentBlock}
    <ol class="mock-flow-steps">
      <li>Click <strong>Autofill test flow</strong> and sign in</li>
      <li>Pay with Paystack (MoMo or card) using the test email/phone</li>
      <li>Pick any open day/time and register</li>
    </ol>
  `;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
