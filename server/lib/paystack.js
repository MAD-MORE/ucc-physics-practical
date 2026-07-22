const crypto = require('crypto');

const PAYSTACK_BASE = 'https://api.paystack.co';
const DEFAULT_CURRENCY = 'GHS';
const MIN_AMOUNT_GHS = 0.1;
const DEFAULT_CHANNELS = ['mobile_money', 'bank_transfer', 'card'];

function paystackConfigured() {
  return Boolean(
    String(process.env.PAYSTACK_SECRET_KEY || '').trim() &&
      String(process.env.PAYSTACK_PUBLIC_KEY || '').trim()
  );
}

function paystackKeyMode() {
  const pk = String(process.env.PAYSTACK_PUBLIC_KEY || '');
  const sk = String(process.env.PAYSTACK_SECRET_KEY || '');
  if (pk.includes('_live_') && sk.includes('_live_')) return 'live';
  if (pk.includes('_test_') || sk.includes('_test_')) return 'test';
  if (paystackConfigured()) return 'unknown';
  return 'none';
}

function paystackAllowTest() {
  return String(process.env.PAYSTACK_ALLOW_TEST || '').toLowerCase() === 'true';
}

/** Block TEST keys unless PAYSTACK_ALLOW_TEST=true (local only). */
function assertLivePaystackKeys() {
  const mode = paystackKeyMode();
  if (mode === 'live') return;
  if (mode === 'test' && paystackAllowTest()) return;
  const err = new Error(
    mode === 'test'
      ? 'Paystack TEST keys are blocked. Put LIVE keys (pk_live_ / sk_live_) in .env / Railway.'
      : 'Paystack LIVE keys are required (pk_live_ / sk_live_).'
  );
  err.status = 503;
  throw err;
}

function paystackMockMode() {
  // Explicit only — missing keys must not silently “succeed” as mock in production.
  return String(process.env.PAYSTACK_MOCK || '').toLowerCase() === 'true';
}

function getPublicKey() {
  return String(process.env.PAYSTACK_PUBLIC_KEY || '').trim();
}

function getCurrency() {
  return String(process.env.PAYSTACK_CURRENCY || DEFAULT_CURRENCY)
    .trim()
    .toUpperCase() || DEFAULT_CURRENCY;
}

function getChannels() {
  const raw = String(process.env.PAYSTACK_CHANNELS || '').trim();
  if (!raw) return [...DEFAULT_CHANNELS];
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

function amountToPesewas(amountGhs) {
  return Math.round(Number(amountGhs) * 100);
}

function assertPayableAmount(amountGhs) {
  const amount = Number(amountGhs);
  if (!Number.isFinite(amount) || amount < MIN_AMOUNT_GHS) {
    const err = new Error(`Practical fee must be at least GHS ${MIN_AMOUNT_GHS.toFixed(2)} for Paystack`);
    err.status = 400;
    throw err;
  }
  return amount;
}

/** Ghana local 0XXXXXXXXX → keep Paystack-friendly local form */
function toGhanaMomoPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10 && digits.startsWith('0')) return digits;
  if (digits.length === 9) return `0${digits}`;
  if (digits.startsWith('233') && digits.length === 12) return `0${digits.slice(3)}`;
  return null;
}

function buildReference(studentId) {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `ucc-phy-${studentId}-${stamp}${rand}`;
}

async function paystackRequest(path, { method = 'GET', body } = {}) {
  const secret = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (!secret) {
    const err = new Error('Paystack secret key is not configured');
    err.status = 503;
    throw err;
  }

  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) {
    const detail =
      data?.data?.message ||
      data?.data?.gateway_response ||
      data?.message ||
      'Paystack request failed';
    const err = new Error(detail);
    err.status = res.status || 502;
    err.paystack = data;
    throw err;
  }
  return data;
}

async function initializeTransaction({
  email,
  amountGhs,
  reference,
  metadata = {},
  callbackUrl,
  channels = getChannels(),
  currency = getCurrency(),
}) {
  const amount = assertPayableAmount(amountGhs);
  return paystackRequest('/transaction/initialize', {
    method: 'POST',
    body: {
      email,
      amount: amountToPesewas(amount),
      currency,
      reference,
      callback_url: callbackUrl,
      metadata,
      channels,
    },
  });
}

async function verifyTransaction(reference) {
  return paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
}

/**
 * Direct MoMo charge — Paystack prompts the customer on their phone (live).
 * Test numbers often complete without a real PIN prompt.
 */
async function chargeMobileMoney({
  email,
  amountGhs,
  phone,
  provider,
  reference,
  currency = getCurrency(),
  metadata = {},
}) {
  const amount = assertPayableAmount(amountGhs);
  const momoPhone = toGhanaMomoPhone(phone);
  if (!momoPhone) {
    const err = new Error('Enter a valid Ghana MoMo number (e.g. 0551234987)');
    err.status = 400;
    throw err;
  }
  const code = String(provider || '')
    .trim()
    .toLowerCase();
  if (!['mtn', 'atl', 'vod'].includes(code)) {
    const err = new Error('Choose a MoMo network: MTN, ATMoney, or Telecel');
    err.status = 400;
    throw err;
  }

  return paystackRequest('/charge', {
    method: 'POST',
    body: {
      email,
      amount: amountToPesewas(amount),
      currency,
      reference,
      metadata,
      mobile_money: {
        phone: momoPhone,
        provider: code,
      },
    },
  });
}

async function checkPendingCharge(reference) {
  return paystackRequest(`/charge/${encodeURIComponent(reference)}`);
}

/** Complete a charge that returned status send_otp (voucher / SMS code). */
async function submitChargeOtp({ reference, otp }) {
  const code = String(otp || '').trim();
  const ref = String(reference || '').trim();
  if (!ref) {
    const err = new Error('Payment reference is required');
    err.status = 400;
    throw err;
  }
  if (!code) {
    const err = new Error('Enter the OTP or voucher code from your phone');
    err.status = 400;
    throw err;
  }
  return paystackRequest('/charge/submit_otp', {
    method: 'POST',
    body: { otp: code, reference: ref },
  });
}

function verifyWebhookSignature(rawBody, signature) {
  const secret = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (!secret || !signature) return false;
  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return hash === signature;
}

module.exports = {
  PAYSTACK_BASE,
  MIN_AMOUNT_GHS,
  DEFAULT_CURRENCY,
  DEFAULT_CHANNELS,
  paystackConfigured,
  paystackMockMode,
  paystackKeyMode,
  paystackAllowTest,
  assertLivePaystackKeys,
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
  checkPendingCharge,
  submitChargeOtp,
  verifyWebhookSignature,
};
