const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');

async function readStoredKeys(sql) {
  const rows = await sql`
    SELECT setting_key, setting_value
    FROM settings
    WHERE setting_key IN ('paystack_public_key', 'paystack_secret_key')
  `;
  const map = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  return {
    publicKey: String(map.paystack_public_key || '').trim(),
    secretKey: String(map.paystack_secret_key || '').trim(),
  };
}

/** Apply DB keys into process.env when .env keys are empty. */
async function hydratePaystackEnv(sql) {
  const envPublic = String(process.env.PAYSTACK_PUBLIC_KEY || '').trim();
  const envSecret = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (envPublic && envSecret) return { publicKey: envPublic, secretKey: envSecret, source: 'env' };

  const stored = await readStoredKeys(sql);
  if (stored.publicKey) process.env.PAYSTACK_PUBLIC_KEY = stored.publicKey;
  if (stored.secretKey) process.env.PAYSTACK_SECRET_KEY = stored.secretKey;

  if (stored.publicKey && stored.secretKey) {
    return { ...stored, source: 'settings' };
  }
  return {
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
    source: 'none',
  };
}

function upsertEnvKeys(publicKey, secretKey) {
  let text = '';
  try {
    text = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    text = '';
  }

  const setKey = (src, key, value) => {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(src)) return src.replace(re, line);
    const trimmed = src.replace(/\s*$/, '');
    return `${trimmed}${trimmed ? '\n' : ''}${line}\n`;
  };

  text = setKey(text, 'PAYSTACK_PUBLIC_KEY', publicKey);
  text = setKey(text, 'PAYSTACK_SECRET_KEY', secretKey);
  // Ensure mock is off when connecting real keys
  if (/^PAYSTACK_MOCK=/m.test(text)) {
    text = text.replace(/^PAYSTACK_MOCK=.*$/m, 'PAYSTACK_MOCK=false');
  }
  fs.writeFileSync(ENV_PATH, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

async function savePaystackKeys(sql, publicKey, secretKey) {
  const pk = String(publicKey || '').trim();
  const sk = String(secretKey || '').trim();

  await sql`
    INSERT INTO settings (setting_key, setting_value)
    VALUES ('paystack_public_key', ${pk})
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
  `;
  await sql`
    INSERT INTO settings (setting_key, setting_value)
    VALUES ('paystack_secret_key', ${sk})
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
  `;

  process.env.PAYSTACK_PUBLIC_KEY = pk;
  process.env.PAYSTACK_SECRET_KEY = sk;
  process.env.PAYSTACK_MOCK = 'false';

  try {
    upsertEnvKeys(pk, sk);
  } catch (err) {
    console.warn('Could not write Paystack keys to .env:', err.message);
  }

  return { publicKey: pk, secretKey: sk };
}

function maskKey(key) {
  const value = String(key || '');
  if (value.length < 12) return value ? '••••' : '';
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

async function verifyPaystackKeys(publicKey, secretKey) {
  const pk = String(publicKey || '').trim();
  const sk = String(secretKey || '').trim();

  if (!pk.startsWith('pk_')) {
    throw Object.assign(new Error('Public key must start with pk_test_ or pk_live_'), { status: 400 });
  }
  if (!sk.startsWith('sk_')) {
    throw Object.assign(new Error('Secret key must start with sk_test_ or sk_live_'), { status: 400 });
  }
  const pkMode = pk.includes('_test_') ? 'test' : pk.includes('_live_') ? 'live' : 'unknown';
  const skMode = sk.includes('_test_') ? 'test' : sk.includes('_live_') ? 'live' : 'unknown';
  if (pkMode !== 'unknown' && skMode !== 'unknown' && pkMode !== skMode) {
    throw Object.assign(new Error('Public and secret keys must both be test or both be live'), {
      status: 400,
    });
  }

  const res = await fetch('https://api.paystack.co/balance', {
    headers: { Authorization: `Bearer ${sk}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) {
    throw Object.assign(new Error(data.message || 'Paystack rejected these keys'), {
      status: 401,
    });
  }

  return {
    ok: true,
    mode: skMode,
    business_name: data.data?.[0]?.currency ? undefined : undefined,
    balances: Array.isArray(data.data)
      ? data.data.map((b) => ({
          currency: b.currency,
          balance: Number(b.balance || 0) / 100,
        }))
      : [],
  };
}

module.exports = {
  hydratePaystackEnv,
  savePaystackKeys,
  verifyPaystackKeys,
  maskKey,
  readStoredKeys,
};
