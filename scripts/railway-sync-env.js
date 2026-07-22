/**
 * Push local .env secrets to the linked Railway service (values not printed).
 * Refuses to sync Paystack TEST keys.
 */
const { spawnSync } = require('child_process');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });

function stripQuotes(value) {
  const s = String(value || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function setVar(key, value) {
  const r = spawnSync('npx', ['railway', 'variable', 'set', key, '--stdin'], {
    input: value,
    encoding: 'utf8',
    shell: true,
    cwd: path.join(__dirname, '..'),
  });
  if (r.status !== 0) {
    console.error(`failed ${key}:`, (r.stderr || r.stdout || '').trim());
    process.exit(1);
  }
  console.log(`set ${key}`);
}

const publicKey = stripQuotes(process.env.PAYSTACK_PUBLIC_KEY);
const secretKey = stripQuotes(process.env.PAYSTACK_SECRET_KEY);

if (publicKey.includes('_test_') || secretKey.includes('_test_')) {
  console.error('Refusing to sync Paystack TEST keys to Railway.');
  console.error('Put LIVE keys (pk_live_ / sk_live_) in .env, then run again.');
  process.exit(1);
}

if (!publicKey || !secretKey) {
  console.error('PAYSTACK_PUBLIC_KEY / PAYSTACK_SECRET_KEY are empty.');
  console.error('Paste LIVE keys into .env before syncing.');
  process.exit(1);
}

if (!publicKey.includes('_live_') || !secretKey.includes('_live_')) {
  console.error('Paystack keys must be LIVE (pk_live_ / sk_live_).');
  process.exit(1);
}

const keys = [
  'DATABASE_URL',
  'JWT_SECRET',
  'PRACTICAL_FEE',
  'APP_BASE_URL',
  'PAYSTACK_PUBLIC_KEY',
  'PAYSTACK_SECRET_KEY',
  'PAYSTACK_CURRENCY',
  'PAYSTACK_CHANNELS',
  'PAYSTACK_MOCK',
];

for (const key of keys) {
  let value = stripQuotes(process.env[key]);
  if (key === 'APP_BASE_URL' && (!value || value.includes('localhost'))) {
    value = 'https://web-production-25f46.up.railway.app';
  }
  if (key === 'PAYSTACK_MOCK') value = 'false';
  if (!value) {
    console.log(`skip empty ${key}`);
    continue;
  }
  setVar(key, value);
}

setVar('NODE_ENV', 'production');
setVar('PAYSTACK_ALLOW_TEST', 'false');
console.log('Railway variables updated (LIVE Paystack only).');
console.log('Redeploy the Railway service so the new keys load.');
