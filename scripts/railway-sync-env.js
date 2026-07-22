/**
 * Push local .env secrets to the linked Railway service (values not printed).
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
  const r = spawnSync('npx', ['railway', 'variable', 'set', key, '--stdin', '--skip-deploys'], {
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

const keys = [
  'DATABASE_URL',
  'JWT_SECRET',
  'PRACTICAL_FEE',
  'PAYSTACK_PUBLIC_KEY',
  'PAYSTACK_SECRET_KEY',
  'PAYSTACK_CURRENCY',
  'PAYSTACK_CHANNELS',
  'PAYSTACK_MOCK',
];

for (const key of keys) {
  const value = stripQuotes(process.env[key]);
  if (!value) {
    console.log(`skip empty ${key}`);
    continue;
  }
  setVar(key, value);
}

setVar('NODE_ENV', 'production');
console.log('Railway variables updated.');
