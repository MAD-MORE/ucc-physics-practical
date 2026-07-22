const { neon } = require('@neondatabase/serverless');

let sql;

function getSql() {
  if (!process.env.DATABASE_URL) {
    const err = new Error('DATABASE_URL is not set. Copy .env.example to .env and add your Neon connection string.');
    err.status = 503;
    throw err;
  }
  if (!sql) {
    sql = neon(process.env.DATABASE_URL);
  }
  return sql;
}

/** Tagged-template proxy so `await sql\`...\`` works after lazy init */
const sqlProxy = (strings, ...values) => getSql()(strings, ...values);

module.exports = { sql: sqlProxy, getSql };
