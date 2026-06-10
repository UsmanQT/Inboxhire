// Inboxhire API
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Create table if it doesn't exist
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      gmail_message_id VARCHAR(255) UNIQUE,
      company VARCHAR(255),
      job_title VARCHAR(255),
      status VARCHAR(50) DEFAULT 'applied',
      email_subject TEXT,
      email_from VARCHAR(255),
      applied_date VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Add gmail_message_id column if it doesn't exist (for existing databases)
  await pool.query(`
    ALTER TABLE applications
    ADD COLUMN IF NOT EXISTS gmail_message_id VARCHAR(255) UNIQUE
  `);

  console.log('Database ready');
}

// POST /applications — save a new application (skips duplicates)
app.post('/applications', async (req, res) => {
  const { company, job_title, email_subject, email_from, applied_date, gmail_message_id } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO applications (company, job_title, email_subject, email_from, applied_date, gmail_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (gmail_message_id) DO NOTHING
       RETURNING *`,
      [company, job_title, email_subject, email_from, applied_date, gmail_message_id]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ skipped: true, message: 'Already exists' });
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to save application' });
  }
});

// GET /applications — get all applications
app.get('/applications', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// PUT /applications/:id — update status
app.put('/applications/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const result = await pool.query(
      'UPDATE applications SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to update application' });
  }
});

// DELETE /applications/:id
app.delete('/applications/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('DELETE FROM applications WHERE id = $1', [id]);
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to delete application' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3002;
app.listen(PORT, async () => {
  await initDB();
  console.log(`API Service running on port ${PORT}`);
});
