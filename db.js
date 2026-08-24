const { Pool } = require("pg");

// Render inyecta DATABASE_URL automáticamente al conectar un Web Service
// con una base de datos PostgreSQL del mismo proyecto.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      phone       TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id            SERIAL PRIMARY KEY,
      owner_phone   TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
      contact_phone TEXT NOT NULL,
      contact_name  TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT now(),
      UNIQUE(owner_phone, contact_phone)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      from_phone  TEXT NOT NULL,
      to_phone    TEXT NOT NULL,
      type        TEXT NOT NULL,        -- text | photo | file | audio
      content     TEXT NOT NULL,        -- texto, o dataURL/base64 para adjuntos pequeños
      file_name   TEXT,
      file_size   INTEGER,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Índice para leer rápido el historial entre dos números
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_pair
    ON messages (from_phone, to_phone, created_at);
  `);
}

module.exports = { pool, initSchema };
