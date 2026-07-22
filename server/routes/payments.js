const express = require('express');
const { sql } = require('../db');
const { authRequired } = require('../auth');
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

async function getUnusedSuccessPayment(studentId) {
  const rows = await sql`
    SELECT payment_id, email, phone_number, amount, paid_at, paystack_reference, status
    FROM payments
    WHERE student_id = ${studentId}
      AND status = 'success'
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
  const paid = paidAt ? new Date(paidAt) : new Date();
  const rows = await sql`
    UPDATE payments
    SET
      status = 'success',
      paid_at = ${paid.toISOString()},
      phone_number = COALESCE(${phoneNumber || null}, phone_number)
    WHERE paystack_reference = ${reference}
    RETURNING payment_id, email, phone_number, amount, paid_at, paystack_reference, status
  `;
  return rows[0] || null;
}

async function markPaymentFailed(reference) {
  await sql`
    UPDATE payments
    SET status = 'failed'
    WHERE paystack_reference = ${reference}
      AND status = 'pending'
  `;
}

async function initializePayment(req, res) {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) {
      return res.status(400).json({ error: 'Enter a valid email for Paystack receipt' });
    }

    const [studentRow] = await sql`
      SELECT student_id FROM students WHERE student_id = ${req.user.id} LIMIT 1
    `;
    if (!studentRow) {
      return res.status(401).json({
        error: 'Your student session is out of date. Sign out, then sign in again.',
      });
    }

    const phoneNumber = normalizePhone(req.body.phone_number);
    const portal = await getPortalSettings(sql);

    if (await studentHasActiveBooking(req.user.id)) {
      return res.status(409).json({ error: 'Only one booking is allowed per student' });
    }

    const unused = await getUnusedSuccessPayment(req.user.id);
    if (unused) {
      return res.json({
        already_paid: true,
        mock: paystackMockMode(),
        payment: unused,
        message: 'Payment already completed. You can register now.',
      });
    }

    // Drop abandoned pending attempts so the student can retry
    await sql`
      UPDATE payments
      SET status = 'failed'
      WHERE student_id = ${req.user.id}
        AND status = 'pending'
    `;

    const reference = buildReference(req.user.id);
    const amount = assertPayableAmount(portal.fee);
    const currency = getCurrency();
    const channels = getChannels();

    await sql`
      INSERT INTO payments (
        student_id, email, phone_number, amount, status, paystack_reference, created_at
      )
      VALUES (
        ${req.user.id},
        ${email},
        ${phoneNumber},
        ${amount},
        'pending',
        ${reference},
        NOW()
      )
    `;

    if (paystackMockMode()) {
      const payment = await markPaymentSuccess(reference, { phoneNumber });
      return res.status(201).json({
        mock: true,
        already_paid: false,
        payment,
        reference,
        message: `Mock debit of ${currency} ${amount.toFixed(0)} recorded. Add Paystack keys for live checkout.`,
      });
    }

    const [student] = await sql`
      SELECT index_number, full_name
      FROM students
      WHERE student_id = ${req.user.id}
      LIMIT 1
    `;

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
        student_id: req.user.id,
        index_number: student?.index_number || '',
        full_name: student?.full_name || req.user.name || '',
        phone_number: phoneNumber,
        custom_fields: [
          {
            display_name: 'Index number',
            variable_name: 'index_number',
            value: student?.index_number || '',
          },
          {
            display_name: 'Student name',
            variable_name: 'full_name',
            value: student?.full_name || req.user.name || '',
          },
        ],
      },
    });

    res.status(201).json({
      mock: false,
      already_paid: false,
      reference: init.data.reference || reference,
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

    const owned = await sql`
      SELECT payment_id, student_id, status, amount, email, phone_number, paystack_reference
      FROM payments
      WHERE paystack_reference = ${reference}
        AND student_id = ${req.user.id}
      LIMIT 1
    `;
    if (!owned[0]) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (owned[0].status === 'success') {
      return res.json({
        payment: owned[0],
        message: 'Payment already confirmed. You can register now.',
      });
    }

    if (paystackMockMode()) {
      const payment = await markPaymentSuccess(reference);
      return res.json({
        payment,
        message: `GHS ${Number(payment.amount).toFixed(0)} debit confirmed. You can register now.`,
      });
    }

    const verified = await verifyTransaction(reference);
    const data = verified.data || {};
    const gatewayStatus = String(data.status || '').toLowerCase();

    if (gatewayStatus === 'success') {
      const expectedPesewas = amountToPesewas(owned[0].amount);
      const paidCurrency = String(data.currency || '').toUpperCase();
      const expectedCurrency = getCurrency();
      if (Number(data.amount) !== expectedPesewas || paidCurrency !== expectedCurrency) {
        await markPaymentFailed(reference);
        return res.status(402).json({
          error: `Paid amount/currency did not match the practical fee (${expectedCurrency} ${Number(owned[0].amount).toFixed(2)})`,
        });
      }

      const phoneFromPaystack =
        normalizePhone(data.authorization?.mobile || data.customer?.phone) || owned[0].phone_number;

      const payment = await markPaymentSuccess(reference, {
        phoneNumber: phoneFromPaystack,
        paidAt: data.paid_at || data.paidAt,
      });

      return res.json({
        payment,
        status: 'success',
        message: `GHS ${Number(payment.amount).toFixed(0)} debited via Paystack. You can register now.`,
      });
    }

    // Still waiting for phone PIN / network (do not mark failed yet)
    if (['ongoing', 'pending', 'processing', 'queued', 'pay_offline', 'abandoned'].includes(gatewayStatus)) {
      return res.json({
        status: gatewayStatus || 'pending',
        pending: true,
        reference,
        message: data.gateway_response || 'Waiting for MoMo approval on your phone…',
      });
    }

    await markPaymentFailed(reference);
    return res.status(402).json({
      error: data.gateway_response || data.message || 'Payment was not successful. Try again.',
      status: gatewayStatus || 'failed',
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Payment verification failed' });
  }
}

router.get('/config', authRequired(['student']), async (_req, res) => {
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
      momo_providers: [
        { code: 'mtn', label: 'MTN MoMo' },
        { code: 'vod', label: 'Telecel Cash' },
        { code: 'atl', label: 'ATMoney' },
      ],
      test_momo_number: '0551234987',
      callback_hint:
        'Live MoMo: student enters their number, approves with PIN on the phone. Test keys cannot debit real wallets.',
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

    const provider = String(req.body.provider || '')
      .trim()
      .toLowerCase();
    if (!['mtn', 'atl', 'vod'].includes(provider)) {
      return res.status(400).json({ error: 'Select MTN, ATMoney, or Telecel' });
    }

    const [studentRow] = await sql`
      SELECT student_id, index_number, full_name
      FROM students
      WHERE student_id = ${req.user.id}
      LIMIT 1
    `;
    if (!studentRow) {
      return res.status(401).json({
        error: 'Your student session is out of date. Sign out, then sign in again.',
      });
    }

    const portal = await getPortalSettings(sql);
    if (await studentHasActiveBooking(req.user.id)) {
      return res.status(409).json({ error: 'Only one booking is allowed per student' });
    }

    const unused = await getUnusedSuccessPayment(req.user.id);
    if (unused) {
      return res.json({
        already_paid: true,
        payment: unused,
        message: 'Payment already completed. You can register now.',
      });
    }

    await sql`
      UPDATE payments
      SET status = 'failed'
      WHERE student_id = ${req.user.id}
        AND status = 'pending'
    `;

    const reference = buildReference(req.user.id);
    const amount = assertPayableAmount(portal.fee);
    const currency = getCurrency();

    await sql`
      INSERT INTO payments (
        student_id, email, phone_number, amount, status, paystack_reference, created_at
      )
      VALUES (
        ${req.user.id},
        ${email},
        ${phoneNumber},
        ${amount},
        'pending',
        ${reference},
        NOW()
      )
    `;

    if (paystackMockMode()) {
      const payment = await markPaymentSuccess(reference, { phoneNumber });
      return res.status(201).json({
        mock: true,
        already_paid: false,
        payment,
        reference,
        status: 'success',
        message: `Mock MoMo debit of ${currency} ${amount.toFixed(0)} recorded.`,
      });
    }

    const liveMode = String(getPublicKey()).includes('_live_');

    try {
      const charge = await chargeMobileMoney({
        email,
        amountGhs: amount,
        phone: phoneNumber,
        provider,
        reference,
        currency,
        metadata: {
          student_id: req.user.id,
          index_number: studentRow.index_number,
          full_name: studentRow.full_name,
          custom_fields: [
            {
              display_name: 'Index number',
              variable_name: 'index_number',
              value: studentRow.index_number,
            },
          ],
        },
      });

      const data = charge.data || {};
      const status = String(data.status || '').toLowerCase();

      if (status === 'success') {
        const payment = await markPaymentSuccess(reference, { phoneNumber });
        return res.status(201).json({
          mock: false,
          already_paid: false,
          payment,
          reference,
          status: 'success',
          message: `${currency} ${amount.toFixed(0)} debited from ${phoneNumber}. You can register now.`,
        });
      }

      if (status === 'failed' || status === 'timeout') {
        await markPaymentFailed(reference);
        let error = data.message || data.gateway_response || 'MoMo debit failed. Try again.';
        if (!liveMode && /test mobile money number/i.test(error)) {
          error =
            'Paystack test keys cannot debit real MoMo wallets. Put LIVE keys (pk_live_ / sk_live_) in .env or run npm run paystack:connect, then students can pay with their own numbers.';
        }
        return res.status(402).json({ error });
      }

      // pay_offline / pending — customer must approve on their phone (live MoMo)
      return res.status(201).json({
        mock: false,
        already_paid: false,
        reference: data.reference || reference,
        status: status || 'pay_offline',
        display_text:
          data.display_text ||
          `Approve the GHS ${amount.toFixed(0)} debit on ${phoneNumber} — enter your MoMo PIN on the phone.`,
        wait_for_phone: true,
        poll_seconds: 180,
        message:
          data.display_text ||
          `Debit prompt sent to ${phoneNumber}. Enter your MoMo PIN on the phone to finish.`,
        live_mode: liveMode,
      });
    } catch (chargeErr) {
      await markPaymentFailed(reference);
      let detail = chargeErr.paystack?.data?.message || chargeErr.message || 'MoMo charge failed';
      if (!liveMode && /test mobile money number|test transaction/i.test(detail)) {
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
    const detail = err.paystack?.data?.message || err.message || 'MoMo charge failed';
    res.status(err.status || 500).json({ error: detail });
  }
}

router.post('/initialize', authRequired(['student']), initializePayment);
router.post('/momo', authRequired(['student']), chargeMomoPayment);
router.post('/verify', authRequired(['student']), verifyPayment);
/** Backward-compatible alias for older clients / smoke tests */
router.post('/', authRequired(['student']), initializePayment);

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
        await markPaymentSuccess(reference, {
          phoneNumber: normalizePhone(event.data?.authorization?.mobile || event.data?.customer?.phone),
          paidAt: event.data?.paid_at,
        });
      } else if (event.event === 'charge.failed') {
        await markPaymentFailed(reference);
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
