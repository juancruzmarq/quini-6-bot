const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

const query = (text, params) => pool.query(text, params);

const getClient = () => pool.connect();

/**
 * Ejecuta el schema SQL si la tabla users no existe.
 * Útil cuando la DB es externa (Railway Postgres) y no tiene init scripts.
 */
async function runSchemaIfNeeded() {
  const hasUsers = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users'
    )
  `).then(r => r.rows[0].exists);

  if (hasUsers) return;

  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('✅ Schema de base de datos inicializado');
}

module.exports = { query, getClient, pool, runSchemaIfNeeded };
