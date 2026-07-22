const path = require('path');
const readline = require('readline');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const { neon } = require('@neondatabase/serverless');
const { savePaystackKeys, verifyPaystackKeys, maskKey } = require('../server/lib/paystack-config');

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  const publicArg = process.argv[2];
  const secretArg = process.argv[3];

  let publicKey = publicArg;
  let secretKey = secretArg;

  if (!publicKey || !secretKey) {
    console.log('Paystack connect');
    console.log('1) Open https://dashboard.paystack.com/#/settings/developer');
    console.log('2) Switch to Live (or Test), copy Public + Secret keys');
    console.log('3) Keys are saved to .env only (never commit that file)');
    console.log('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    publicKey = (await ask(rl, 'Public key (pk_live_… or pk_test_…): ')).trim();
    secretKey = (await ask(rl, 'Secret key (sk_live_… or sk_test_…): ')).trim();
    rl.close();
  }

  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }

  console.log('Verifying with Paystack…');
  const verified = await verifyPaystackKeys(publicKey, secretKey);
  const sql = neon(process.env.DATABASE_URL);
  await savePaystackKeys(sql, publicKey, secretKey);

  console.log('Connected.');
  console.log(`Mode: ${verified.mode}`);
  console.log(`Public: ${maskKey(publicKey)}`);
  console.log(`Secret: ${maskKey(secretKey)}`);
  if (verified.balances?.length) {
    console.log(
      'Balances:',
      verified.balances.map((b) => `${b.currency} ${b.balance}`).join(', ')
    );
  }
  console.log('Restart the server if it is already running, then pay from the student portal.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
