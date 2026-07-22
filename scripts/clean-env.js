/**
 * Clean local env files: drop unused Neon Auth vars, clear Paystack TEST keys,
 * keep DATABASE_URL in .env.local, strengthen weak JWT_SECRET.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const localPath = path.join(root, '.env.local');

const cur = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
const loc = fs.existsSync(localPath) ? dotenv.parse(fs.readFileSync(localPath, 'utf8')) : {};

function unquote(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

const dbUrl = unquote(loc.DATABASE_URL || cur.DATABASE_URL);
const dbUnpooled = unquote(loc.DATABASE_URL_UNPOOLED || cur.DATABASE_URL_UNPOOLED);
if (!dbUrl) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

let jwt = String(cur.JWT_SECRET || '').trim();
const weakJwt =
  !jwt ||
  jwt.includes('dev-secret') ||
  jwt.includes('change-in-production') ||
  jwt.includes('change-me');
if (weakJwt) {
  jwt = crypto.randomBytes(48).toString('base64url');
  console.log('Generated new JWT_SECRET');
} else {
  console.log('Kept existing JWT_SECRET');
}

const pk = String(cur.PAYSTACK_PUBLIC_KEY || '').trim();
const sk = String(cur.PAYSTACK_SECRET_KEY || '').trim();
const hadTest = pk.includes('_test_') || sk.includes('_test_');
const keepLive = pk.includes('_live_') && sk.includes('_live_');

const envText = [
  '# UCC Physics Practical — local secrets (gitignored)',
  '# Database lives in .env.local (neonctl env pull).',
  '',
  `JWT_SECRET=${jwt}`,
  'PORT=3000',
  'PRACTICAL_FEE=50.00',
  'APP_BASE_URL=http://localhost:3000',
  '',
  '# Paystack LIVE keys only (pk_live_ / sk_live_). Do not use pk_test_ / sk_test_.',
  '# https://dashboard.paystack.com/#/settings/developer',
  `PAYSTACK_PUBLIC_KEY=${keepLive ? pk : ''}`,
  `PAYSTACK_SECRET_KEY=${keepLive ? sk : ''}`,
  'PAYSTACK_CURRENCY=GHS',
  'PAYSTACK_CHANNELS=mobile_money,card',
  'PAYSTACK_MOCK=false',
  '',
].join('\n');

const localText = [
  '# Neon connection (from neonctl env pull) — do not commit',
  'NEON_BRANCH=main',
  `DATABASE_URL="${dbUrl}"`,
  `DATABASE_URL_UNPOOLED="${dbUnpooled}"`,
  '',
].join('\n');

fs.writeFileSync(envPath, envText);
fs.writeFileSync(localPath, localText);

console.log('Wrote clean .env and .env.local');
if (hadTest && !keepLive) {
  console.log('Cleared Paystack TEST keys. Paste LIVE keys into .env, then run: npm run railway:env');
} else if (keepLive) {
  console.log('Kept Paystack LIVE keys.');
} else {
  console.log('Paystack keys empty. Paste LIVE keys into .env, then run: npm run railway:env');
}
