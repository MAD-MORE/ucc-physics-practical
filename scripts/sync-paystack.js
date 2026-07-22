const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const { neon } = require('@neondatabase/serverless');
const {
  paystackConfigured,
  paystackMockMode,
  getCurrency,
  getChannels,
  MIN_AMOUNT_GHS,
  amountToPesewas,
  initializeTransaction,
  buildReference,
} = require('../server/lib/paystack');
const { hydratePaystackEnv, verifyPaystackKeys, maskKey } = require('../server/lib/paystack-config');
const { getPortalSettings } = require('../server/lib/portal');
const fs = require('fs');

const ENV_PATH = path.join(__dirname, '..', '.env');

function upsertEnv(key, value) {
  let text = '';
  try {
    text = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    text = '';
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) text = text.replace(re, line);
  else text = `${text.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(ENV_PATH, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);
  console.log('Syncing Paystack requirements…');

  const keys = await hydratePaystackEnv(sql);
  if (!paystackConfigured()) {
    console.error('Paystack keys missing. Add them to .env or run: npm run paystack:connect');
    process.exit(1);
  }

  // Canonical Ghana settings
  process.env.PAYSTACK_MOCK = 'false';
  process.env.PAYSTACK_CURRENCY = getCurrency() || 'GHS';
  if (!process.env.PAYSTACK_CHANNELS) {
    process.env.PAYSTACK_CHANNELS = 'mobile_money,card';
  }
  if (!process.env.APP_BASE_URL) {
    process.env.APP_BASE_URL = 'http://localhost:3000';
  }

  upsertEnv('PAYSTACK_MOCK', 'false');
  upsertEnv('PAYSTACK_CURRENCY', process.env.PAYSTACK_CURRENCY);
  upsertEnv('PAYSTACK_CHANNELS', process.env.PAYSTACK_CHANNELS);
  upsertEnv('APP_BASE_URL', process.env.APP_BASE_URL);

  const verified = await verifyPaystackKeys(keys.publicKey || process.env.PAYSTACK_PUBLIC_KEY, keys.secretKey || process.env.PAYSTACK_SECRET_KEY);
  console.log(`Keys OK (${verified.mode}) · ${maskKey(process.env.PAYSTACK_PUBLIC_KEY)}`);

  const portal = await getPortalSettings(sql);
  if (Number(portal.fee) < MIN_AMOUNT_GHS) {
    console.error(`practical_fee GHS ${portal.fee} is below Paystack minimum GHS ${MIN_AMOUNT_GHS}`);
    process.exit(1);
  }

  await sql`
    INSERT INTO settings (setting_key, setting_value)
    VALUES ('paystack_currency', ${process.env.PAYSTACK_CURRENCY})
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
  `;
  await sql`
    INSERT INTO settings (setting_key, setting_value)
    VALUES ('paystack_channels', ${process.env.PAYSTACK_CHANNELS})
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
  `;

  // Expire abandoned pending rows so students can retry cleanly
  const expired = await sql`
    UPDATE payments
    SET status = 'failed'
    WHERE status = 'pending'
      AND created_at < NOW() - INTERVAL '2 hours'
    RETURNING payment_id
  `;

  // Dry-run initialize against Paystack (then we don't need to complete it)
  const reference = buildReference('sync');
  const init = await initializeTransaction({
    email: 'paystack.sync@test.ucc.edu.gh',
    amountGhs: portal.fee,
    reference,
    callbackUrl: `${process.env.APP_BASE_URL.replace(/\/$/, '')}/student.html?paystack=1`,
    metadata: { sync: true, purpose: 'ucc-physics-practical' },
  });

  console.log('Paystack sync complete.');
  console.log(`  Mode:          ${verified.mode}`);
  console.log(`  Mock:          ${paystackMockMode()}`);
  console.log(`  Currency:      ${getCurrency()}`);
  console.log(`  Channels:      ${getChannels().join(', ')}`);
  console.log(`  Fee:           GHS ${Number(portal.fee).toFixed(2)} (${amountToPesewas(portal.fee)} pesewas)`);
  console.log(`  Callback:      ${process.env.APP_BASE_URL}/student.html?paystack=1`);
  console.log(`  Access code:   ${init.data.access_code ? 'received' : 'missing'}`);
  console.log(`  Expired pending payments: ${expired.length}`);
  if (verified.balances?.length) {
    console.log(
      `  Balances:      ${verified.balances.map((b) => `${b.currency} ${b.balance}`).join(', ')}`
    );
  }
  console.log('Restart the server, then pay from the student portal.');
}

main().catch((err) => {
  console.error(err.message || err);
  if (err.paystack) console.error(JSON.stringify(err.paystack, null, 2));
  process.exit(1);
});
