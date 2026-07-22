const FEE_FALLBACK = Number(process.env.PRACTICAL_FEE || 50);
const { paystackConfigured, paystackMockMode } = require('./paystack');

async function getPortalSettings(sql) {
  const rows = await sql`
    SELECT setting_key, setting_value
    FROM settings
    WHERE setting_key IN ('registration_open', 'practical_fee')
  `;
  const map = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  const [schedules] = await sql`
    SELECT COUNT(*)::int AS c FROM schedules WHERE status = 'open'
  `;

  return {
    registration_open: (map.registration_open || 'false') === 'true',
    fee: Number(map.practical_fee || FEE_FALLBACK),
    open_session_count: schedules.c,
    paystack_connected: paystackConfigured() && !paystackMockMode(),
    paystack_mock: paystackMockMode(),
  };
}

module.exports = {
  FEE_FALLBACK,
  getPortalSettings,
};
