# UCC Physics Practical Registration System

Web app for University of Cape Coast Physics practical registration and scheduling.

**Stack:** HTML · CSS · JavaScript · Express · Neon Postgres

## Features

- Student signup / login, MoMo payment, and session registration
- Students pick Monday–Sunday practical times set by the lecturer
- Admin day/time slots with overlap checks
- Open / close the registration window

## Setup

1. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `JWT_SECRET`, and Paystack keys.
2. Install and run:

```bash
npm install
npm run db:schema
npm run db:seed
npm start
```

Open http://localhost:3000

## Deploy

Host the Node app on Railway (or similar) and keep Postgres on Neon. Store secrets in the host’s environment variables — never commit `.env`.

```bash
npm run railway:env   # optional: sync local .env keys to Railway
npx railway up -y     # or connect the GitHub repo for auto-deploy
```

Paystack webhook: `https://YOUR_HOST/api/webhooks/paystack`

## Student flow

1. Sign in or create an account  
2. Pay the practical fee (MoMo / card)  
3. Choose a session and register  

## Admin flow

1. Sign in as admin  
2. Add slots under **Add slot**  
3. Open or close registration  

## Layout

```
public/     frontend
server/     Express API
db/         schema
scripts/    migrate / seed helpers
```

## Paystack

Put keys only in `.env`:

```env
PAYSTACK_PUBLIC_KEY=
PAYSTACK_SECRET_KEY=
PAYSTACK_MOCK=false
```
