const path = require('path');
// Load .env with override so shell leftovers (e.g. PAYSTACK_MOCK=true) cannot force mock mode
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/student');
const adminRoutes = require('./routes/admin');
const { router: paymentRoutes, createWebhookRouter } = require('./routes/payments');
const { sql } = require('./db');
const { getPortalSettings } = require('./lib/portal');
const { paystackConfigured, paystackMockMode } = require('./lib/paystack');
const { hydratePaystackEnv } = require('./lib/paystack-config');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.set('trust proxy', 1);
app.use(cors());
// Paystack webhooks need the raw body for signature verification
app.use('/api/webhooks/paystack', express.raw({ type: 'application/json' }), createWebhookRouter());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    db: Boolean(process.env.DATABASE_URL),
    service: 'UCC Physics Practical Registration',
    paystack: {
      configured: paystackConfigured(),
      mock: paystackMockMode(),
    },
  });
});

app.get('/api/portal/status', async (_req, res) => {
  try {
    const settings = await getPortalSettings(sql);
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load portal status' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/student/payments', paymentRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

async function start() {
  try {
    if (process.env.DATABASE_URL) {
      const keys = await hydratePaystackEnv(sql);
      if (keys.source === 'settings') {
        console.log('Paystack: keys loaded from database settings');
      }
    }
  } catch (err) {
    console.warn('Paystack hydrate skipped:', err.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    const publicUrl = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
    console.log(`UCC Physics Practical running at ${publicUrl}`);
    if (!process.env.DATABASE_URL) {
      console.log('Set DATABASE_URL in .env (see .env.example)');
    }
    if (paystackMockMode()) {
      console.log(
        paystackConfigured()
          ? 'Paystack: MOCK mode (PAYSTACK_MOCK=true)'
          : 'Paystack: not connected — add keys to .env, or run: npm run paystack:connect'
      );
    } else {
      const mode = String(process.env.PAYSTACK_SECRET_KEY || '').includes('_live_') ? 'live' : 'test';
      console.log(`Paystack: ${mode} keys connected`);
    }
  });
}

start();
