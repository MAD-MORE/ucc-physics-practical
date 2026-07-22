const express = require('express');
const { sql } = require('../db');
const { authRequired } = require('../auth');
const { getPendingById, finalizePendingPayment } = require('../lib/pending-signup');
const { getPortalSettings } = require('../lib/portal');
const {
  paystackMockMode,
  getPublicKey,
  getCurrency,
  getChannels,
  amountToPesewas,
  assertPayableAmount,
  toGhanaMomoPhone,
  buildReference,
  initializeTransaction,
  verifyTransaction,
  chargeMobileMoney,
  verifyWebhookSignature,
  assertLivePaystackKeys,
  submitChargeOtp,
} = require('../lib/paystack');

const router = express.Router();

function normalizePhone(phone) {
  return toGhanaMomoPhone(phone);
}

function normalizeEmail(email) {
  const value = String(email || '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

/** Turn raw Paystack/MoMo gateway codes into actionable copy for students. */
function friendlyPaystackError(raw, { phone } = {}) {
  const text = String(raw || '').trim();
  if (!text) return 'MoMo debit failed. Try again or use bank transfer / card.';

  const upper = text.toUpperCase();
  if (upper.includes('LOW_BALANCE') || upper.includes('PAYEE_LIMIT') || upper.includes('NOT_ALLOWED')) {
    const phoneHint = phone ? ` on ${phone}` : '';
    return (
      `MoMo could not debit${phoneHint}. Check MTN balance and that the number is an MTN MoMo wallet. Or pay with bank transfer / card instead.`
    );
  }
  if (/insufficient|low balance/i.test(text)) {
    return 'Insufficient MoMo balance. Top up and try again, or pay with bank transfer / card.';
  }
  if (/invalid.*phone|unknown subscriber|not registered/i.test(text)) {
    return 'That phone number is not registered for the selected MoMo network. Check the number and network.';
  }
  if (/declined|do not honor|not permitted/i.test(text)) {
    return 'The MoMo provider declined this payment. Try another number, bank transfer, or card.';
  }
  // Avoid dumping pure SCREAMING_SNAKE codes alone
  if (/^[A-Z0-9_]+$/.test(text) && text.includes('_')) {
    return `${text.replace(/_/g, ' ').toLowerCase()}. Try another MoMo number, or pay with bank transfer / card.`;
  }
  return text;
}

async function getUnusedSuccessPayment(studentId) {
  const rows = await sql`
    SELECT payment_id, email, phone_number, amount, paid_at, paystack_reference, status
    FROM payments
    WHERE student_id = ${studentId}
      AND status = 'success'
      AND paid_at IS NOT NULL
      AND payment_id NOT IN (SELECT payment_id FROM registrations)
    ORDER BY paid_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

async function studentHasActiveBooking(studentId) {
  const rows = await sql`
    SELECT registration_id
    FROM registrations
    WHERE student_id = ${studentId} AND status = 'active'
    LIMIT 1
  `;
  return Boolean(rows[0]);
}

async function markPaymentSuccess(reference, { phoneNumber, paidAt } = {}) {
  const finalized = await finalizePendingPayment(reference, { phoneNumber, paidAt });
  return finalized?.payment || null;
}

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

  const [student] = await sql`
    SELECT student_id, index_number, full_name, email
    FROM students
    WHERE student_id = ${req.user.id}
    LIMIT 1
  `;
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
    await sql`
      DELETE FROM payments
      WHERE pending_signup_id = ${owner.pendingId}
        AND status IN ('pending', 'failed')
    `;
    return;
  }
  await sql`
    DELETE FROM payments
    WHERE student_id = ${owner.studentId}
      AND status IN ('pending', 'failed')
  `;
}

/** Declined / abandoned attempts are removed — only successful payments stay in DB. */
async function deleteFailedPaymentAttempt(reference) {
  await sql`
    DELETE FROM payments
    WHERE paystack_reference = ${reference}
      AND status = 'pending'
  `;
}

function sameId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/** Pending signups own rows via pending_signup_id; students via student_id. */
async function findOwnedPayment(req, reference) {
  const rows = await sql`
    SELECT payment_id, student_id, pending_signup_id, status, amount, email, phone_number, paystack_reference
    FROM payments
    WHERE paystack_reference = ${reference}
    LIMIT 1
  `;
  const payment = rows[0];
  if (!payment) return null;

  if (req.user.role === 'student' && sameId(payment.student_id, req.user.id)) {
    return payment;
  }
  if (req.user.role === 'pending' && sameId(payment.pending_signup_id, req.user.id)) {
    return payment;
  }
  return null;
}

/** Keep DB reference in sync if Paystack returns a different one. */
async function syncPaystackReference(localReference, gatewayReference) {
  const next = String(gatewayReference || '').trim();
  const current = String(localReference || '').trim();
  if (!next || !current || next === current) return current;
  await sql`
    UPDATE payments
    SET paystack_reference = ${next}
    WHERE paystack_reference = ${current}
      AND status = 'pending'
  `;
  return next;
}

async function initializePayment(req, res) {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) {
      return res.status(400).json({ error: 'Enter a valid email for Paystack receipt' });
    }

    const owner = await resolvePaymentOwner(req);
    const phoneNumber = normalizePhone(req.body.phone_number);
    const portal = await getPortalSettings(sql);

    if (owner.kind === 'student') {
      if (await studentHasActiveBooking(owner.studentId)) {
        return res.status(409).json({ error: 'Only one booking is allowed per student' });
      }
      const unused = await getUnusedSuccessPayment(owner.studentId);
      if (unused) {
        return res.json({
          already_paid: true,
          mock: paystackMockMode(),
          payment: unused,
          message: 'Payment already completed. You can register now.',
        });
      }
    }

    if (!paystackMockMode()) {
      assertLivePaystackKeys();
    }

    await clearOwnerPendingPayments(owner);

    const reference = buildReference(owner.pendingId || owner.studentId);
    const amount = assertPayableAmount(portal.fee);
    const currency = getCurrency();
    const requested = Array.isArray(req.body.channels)
      ? req.body.channels.map((c) => String(c).trim()).filter(Boolean)
      : [];
    const channels = requested.length ? requested : getChannels();

    await sql`
      INSERT INTO payments (
        student_id, pending_signup_id, email, phone_number, amount, status, paystack_reference, created_at
      )
      VALUES (
        ${owner.studentId},
        ${owner.pendingId},
        ${email},
        ${phoneNumber},
        ${amount},
        'pending',
        ${reference},
        NOW()
      )
    `;

    try {
      if (paystackMockMode()) {
        const finalized = await finalizePendingPayment(reference, { phoneNumber });
        return res.status(201).json({
          mock: true,
          already_paid: false,
          payment: finalized.payment,
          reference,
          token: finalized.token || undefined,
          user: finalized.user || undefined,
          message:
            owner.kind === 'pending'
              ? 'Mock payment recorded. Account created.'
              : `Mock debit of ${currency} ${amount.toFixed(0)} recorded.`,
        });
      }

      const baseUrl = (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(
        /\/$/,
        ''
      );
      const init = await initializeTransaction({
        email,
        amountGhs: amount,
        reference,
        currency,
        channels,
        callbackUrl: `${baseUrl}/student.html?paystack=return`,
        metadata: {
          student_id: owner.studentId,
          pending_signup_id: owner.pendingId,
          index_number: owner.index_number || '',
          full_name: owner.full_name || req.user.name || '',
          phone_number: phoneNumber,
          custom_fields: [
            {
              display_name: 'Index number',
              variable_name: 'index_number',
              value: owner.index_number || '',
            },
            {
              display_name: 'Student name',
              variable_name: 'full_name',
              value: owner.full_name || req.user.name || '',
            },
          ],
        },
      });

      res.status(201).json({
        mock: false,
        already_paid: false,
        reference: await syncPaystackReference(reference, init.data.reference),
        access_code: init.data.access_code,
        authorization_url: init.data.authorization_url,
        public_key: getPublicKey(),
        email,
        amount,
        amount_pesewas: amountToPesewas(amount),
        currency,
        channels,
        message: 'Paystack checkout ready',
      });
    } catch (initErr) {
      await deleteFailedPaymentAttempt(reference);
      throw initErr;
    }
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to start Paystack payment' });
  }
}

async function verifyPayment(req, res) {
  try {
    const reference = String(req.body.reference || '').trim();
    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' });
    }

    const owned = await findOwnedPayment(req, reference);
    if (!owned) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (owned.status === 'success' && owned.student_id) {
      const finalized = await finalizePendingPayment(reference);
      return res.json({
        payment: finalized.payment || owned,
        token: finalized.token || undefined,
        user: finalized.user || undefined,
        message: 'Payment already confirmed. You can register for a session now.',
      });
    }

    if (paystackMockMode()) {
      const finalized = await finalizePendingPayment(reference);
      return res.json({
        payment: finalized.payment,
        token: finalized.token || undefined,
        user: finalized.user || undefined,
        status: 'success',
        message: 'Payment confirmed. Account created — you can register for a session now.',
      });
    }

    const verified = await verifyTransaction(reference);
    const data = verified.data || {};
    const gatewayStatus = String(data.status || '').toLowerCase();

    if (gatewayStatus === 'success') {
      const expectedPesewas = amountToPesewas(owned.amount);
      const paidCurrency = String(data.currency || '').toUpperCase();
      const expectedCurrency = getCurrency();
      if (Number(data.amount) !== expectedPesewas || paidCurrency !== expectedCurrency) {
        await deleteFailedPaymentAttempt(reference);
        return res.status(402).json({
          error: `Paid amount/currency did not match the practical fee (${expectedCurrency} ${Number(owned.amount).toFixed(2)})`,
        });
      }

      const phoneFromPaystack =
        normalizePhone(data.authorization?.mobile || data.customer?.phone) || owned.phone_number;

      const finalized = await finalizePendingPayment(reference, {
        phoneNumber: phoneFromPaystack,
        paidAt: data.paid_at || data.paidAt,
      });

      return res.json({
        payment: finalized.payment,
        token: finalized.token || undefined,
        user: finalized.user || undefined,
        status: 'success',
        message:
          finalized.user
            ? `GHS ${Number(finalized.payment.amount).toFixed(0)} paid. Your account is created — pick a session.`
            : `GHS ${Number(finalized.payment.amount).toFixed(0)} debited via Paystack. You can register now.`,
      });
    }

    // Still waiting for phone PIN / OTP / network (do not mark failed yet)
    if (
      ['ongoing', 'pending', 'processing', 'queued', 'pay_offline', 'abandoned', 'send_otp'].includes(
        gatewayStatus
      )
    ) {
      return res.json({
        status: gatewayStatus || 'pending',
        pending: true,
        reference,
        message:
          gatewayStatus === 'send_otp'
            ? data.display_text || 'Enter the OTP / voucher code to finish payment'
            : data.gateway_response || 'Waiting for MoMo approval on your phone…',
      });
    }

    await deleteFailedPaymentAttempt(reference);
    return res.status(402).json({
      error: data.gateway_response || data.message || 'Payment was not successful. Try again.',
      status: gatewayStatus || 'failed',
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Payment verification failed' });
  }
}

router.get('/config', authRequired(['student', 'pending']), async (_req, res) => {
  try {
    const portal = await getPortalSettings(sql);
    const mock = paystackMockMode();
    const currency = getCurrency();
    res.json({
      mock,
      public_key: mock ? '' : getPublicKey(),
      currency,
      fee: portal.fee,
      amount_pesewas: amountToPesewas(portal.fee),
      channels: getChannels(),
      test_mode: String(getPublicKey()).includes('_test_'),
      live_mode: String(getPublicKey()).includes('_live_'),
      require_live: true,
      momo_providers: [{ code: 'mtn', label: 'MTN MoMo' }],
      callback_hint:
        'MTN MoMo: type your PIN on the phone when prompted. Bank transfer and card also available.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load payment config' });
  }
});

/**
 * Direct MoMo debit via Paystack Charge API.
 * Live: customer gets a prompt on their phone to enter MoMo PIN.
 * Test: use 0551234987 — completes without a real handset prompt.
 */
async function chargeMomoPayment(req, res) {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) {
      return res.status(400).json({ error: 'Enter a valid email for Paystack receipt' });
    }

    const phoneNumber = normalizePhone(req.body.phone_number);
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Enter the MoMo number that will receive the debit prompt' });
    }

    const provider = String(req.body.provider || 'mtn')
      .trim()
      .toLowerCase();
    // MTN only for now — re-enable atl / vod when ready
    if (provider !== 'mtn') {
      return res.status(400).json({
        error: 'Only MTN MoMo is enabled for now. Use an MTN number, or pay by bank transfer / card.',
      });
    }
    const normalizedProvider = 'mtn';

    const owner = await resolvePaymentOwner(req);
    const portal = await getPortalSettings(sql);

    if (owner.kind === 'student') {
      if (await studentHasActiveBooking(owner.studentId)) {
        return res.status(409).json({ error: 'Only one booking is allowed per student' });
      }
      const unused = await getUnusedSuccessPayment(owner.studentId);
      if (unused) {
        return res.json({
          already_paid: true,
          payment: unused,
          message: 'Payment already completed. You can register now.',
        });
      }
    }

    if (!paystackMockMode()) {
      assertLivePaystackKeys();
    }

    await clearOwnerPendingPayments(owner);

    const reference = buildReference(owner.pendingId || owner.studentId);
    const amount = assertPayableAmount(portal.fee);
    const currency = getCurrency();

    await sql`
      INSERT INTO payments (
        student_id, pending_signup_id, email, phone_number, amount, status, paystack_reference, created_at
      )
      VALUES (
        ${owner.studentId},
        ${owner.pendingId},
        ${email},
        ${phoneNumber},
        ${amount},
        'pending',
        ${reference},
        NOW()
      )
    `;

    if (paystackMockMode()) {
      const finalized = await finalizePendingPayment(reference, { phoneNumber });
      return res.status(201).json({
        mock: true,
        already_paid: false,
        payment: finalized.payment,
        reference,
        status: 'success',
        token: finalized.token || undefined,
        user: finalized.user || undefined,
        message: `Mock MoMo debit of ${currency} ${amount.toFixed(0)} recorded.`,
      });
    }

    const liveMode = String(getPublicKey()).includes('_live_');

    try {
      const charge = await chargeMobileMoney({
        email,
        amountGhs: amount,
        phone: phoneNumber,
        provider: normalizedProvider,
        reference,
        currency,
        metadata: {
          student_id: owner.studentId,
          pending_signup_id: owner.pendingId,
          index_number: owner.index_number,
          full_name: owner.full_name,
          custom_fields: [
            {
              display_name: 'Index number',
              variable_name: 'index_number',
              value: owner.index_number,
            },
          ],
        },
      });

      const data = charge.data || {};
      const status = String(data.status || '').toLowerCase();

      const gatewayReference = await syncPaystackReference(reference, data.reference);

      if (status === 'success') {
        const finalized = await finalizePendingPayment(gatewayReference, { phoneNumber });
        return res.status(201).json({
          mock: false,
          already_paid: false,
          payment: finalized.payment,
          reference: gatewayReference,
          status: 'success',
          token: finalized.token || undefined,
          user: finalized.user || undefined,
          message: `${currency} ${amount.toFixed(0)} debited from ${phoneNumber}. Account ready.`,
        });
      }

      if (status === 'failed' || status === 'timeout') {
        await deleteFailedPaymentAttempt(gatewayReference);
        let error = friendlyPaystackError(
          data.message || data.gateway_response || 'MoMo debit failed. Try again.',
          { phone: phoneNumber }
        );
        if (!liveMode && /test mobile money number/i.test(String(data.message || data.gateway_response || ''))) {
          error =
            'Paystack test keys cannot debit real MoMo wallets. Put LIVE keys (pk_live_ / sk_live_) in .env or run npm run paystack:connect, then students can pay with their own numbers.';
        }
        return res.status(402).json({ error });
      }

      if (status === 'send_otp') {
        // send_otp is for Telecel-style voucher flows — not used while MTN-only
        return res.status(201).json({
          mock: false,
          already_paid: false,
          reference: gatewayReference,
          status: 'send_otp',
          needs_otp: normalizedProvider !== 'mtn',
          wait_for_phone: normalizedProvider === 'mtn',
          ussd_code: data.ussd_code || '',
          display_text:
            normalizedProvider === 'mtn'
              ? data.display_text ||
                `Approve on your phone — enter your MTN MoMo PIN when prompted (${phoneNumber}).`
              : data.display_text ||
                'Follow the instruction on your phone, then enter the OTP / voucher code below.',
          message:
            normalizedProvider === 'mtn'
              ? 'Check your phone and type your MTN MoMo PIN.'
              : data.display_text || 'Enter the OTP or voucher code from your phone to finish payment.',
          live_mode: liveMode,
        });
      }

      // MTN / ATMoney: pay_offline → PIN prompt on the handset. Do NOT open a website voucher form.
      const ussd = String(data.ussd_code || '').trim();
      const display =
        data.display_text ||
        `Check your phone (${phoneNumber}) now and enter your MTN MoMo PIN to approve GHS ${amount.toFixed(0)}.`;

      return res.status(201).json({
        mock: false,
        already_paid: false,
        reference: gatewayReference,
        status: status || 'pay_offline',
        display_text: display,
        ussd_code: ussd,
        wait_for_phone: true,
        needs_otp: false,
        poll_seconds: 180,
        message: display,
        live_mode: liveMode,
      });
    } catch (chargeErr) {
      await deleteFailedPaymentAttempt(reference);
      let detail = friendlyPaystackError(
        chargeErr.paystack?.data?.message || chargeErr.message || 'MoMo charge failed',
        { phone: phoneNumber }
      );
      if (!liveMode && /test mobile money number|test transaction/i.test(String(chargeErr.message || ''))) {
        detail =
          'Paystack test keys cannot debit real MoMo wallets. Put LIVE keys (pk_live_ / sk_live_) in .env or run npm run paystack:connect.';
      }
      const err = new Error(detail);
      err.status = chargeErr.status || 402;
      err.paystack = chargeErr.paystack;
      throw err;
    }
  } catch (err) {
    console.error(err);
    const detail = friendlyPaystackError(
      err.paystack?.data?.message || err.message || 'MoMo charge failed',
      { phone: normalizePhone(req.body?.phone_number) }
    );
    res.status(err.status || 500).json({ error: detail });
  }
}

async function submitMomoOtp(req, res) {
  try {
    const reference = String(req.body.reference || '').trim();
    const otp = String(req.body.otp || '').trim();
    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' });
    }
    if (!otp) {
      return res.status(400).json({ error: 'Enter the OTP or voucher code from your phone' });
    }

    const owned = await findOwnedPayment(req, reference);
    if (!owned) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    if (owned.status === 'success') {
      return res.json({
        payment: owned,
        status: 'success',
        message: 'Payment already confirmed. You can register now.',
      });
    }

    if (!paystackMockMode()) {
      assertLivePaystackKeys();
    }

    const submitted = await submitChargeOtp({ reference, otp });
    const data = submitted.data || {};
    const status = String(data.status || '').toLowerCase();
    const gatewayReference = await syncPaystackReference(reference, data.reference);

    if (status === 'success') {
      const finalized = await finalizePendingPayment(gatewayReference, {
        phoneNumber: owned.phone_number,
        paidAt: data.paid_at || data.transaction_date,
      });
      return res.json({
        status: 'success',
        reference: gatewayReference,
        payment: finalized.payment,
        token: finalized.token || undefined,
        user: finalized.user || undefined,
        message: `GHS ${Number(finalized.payment.amount).toFixed(0)} debited. You can register now.`,
      });
    }

    if (status === 'failed' || status === 'timeout') {
      await deleteFailedPaymentAttempt(gatewayReference);
      return res.status(402).json({
        error: data.message || data.gateway_response || 'OTP / voucher was not accepted. Try again.',
      });
    }

    if (status === 'send_otp') {
      return res.status(400).json({
        error: data.display_text || data.message || 'Enter a valid OTP / voucher code',
        needs_otp: true,
        reference: gatewayReference,
        display_text: data.display_text || '',
      });
    }

    // Still processing after OTP — poll verify
    return res.json({
      status: status || 'pending',
      reference: gatewayReference,
      wait_for_phone: true,
      poll_seconds: 120,
      display_text: data.display_text || 'Confirming payment…',
      message: data.display_text || 'Confirming your MoMo payment…',
    });
  } catch (err) {
    console.error(err);
    const detail = err.paystack?.data?.message || err.message || 'Could not submit OTP';
    res.status(err.status || 500).json({ error: detail });
  }
}

router.post('/initialize', authRequired(['student', 'pending']), initializePayment);
router.post('/momo', authRequired(['student', 'pending']), chargeMomoPayment);
router.post('/momo/otp', authRequired(['student', 'pending']), submitMomoOtp);
router.post('/verify', authRequired(['student', 'pending']), verifyPayment);
/** Backward-compatible alias for older clients / smoke tests */
router.post('/', authRequired(['student', 'pending']), initializePayment);

function createWebhookRouter() {
  const webhook = express.Router();

  webhook.post('/', async (req, res) => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const signature = req.headers['x-paystack-signature'];
      if (!verifyWebhookSignature(rawBody, signature)) {
        return res.status(401).json({ error: 'Invalid Paystack signature' });
      }

      const event = JSON.parse(rawBody || '{}');
      const reference = event?.data?.reference;
      if (!reference) return res.sendStatus(200);

      if (event.event === 'charge.success') {
        await finalizePendingPayment(reference, {
          phoneNumber: normalizePhone(event.data?.authorization?.mobile || event.data?.customer?.phone),
          paidAt: event.data?.paid_at,
        });
      } else if (event.event === 'charge.failed') {
        await deleteFailedPaymentAttempt(reference);
      }

      res.sendStatus(200);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Webhook failed' });
    }
  });

  return webhook;
}

module.exports = { router, createWebhookRouter, getUnusedSuccessPayment };
