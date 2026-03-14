const express = require('express');
const db      = require('../db');

const router = express.Router();

/**
 * POST /api/users
 * Crea o actualiza un usuario por telegram_chat_id (upsert).
 * Body: { telegram_chat_id, name?, telegram_username? }
 */
router.post('/', async (req, res, next) => {
  try {
    const { telegram_chat_id, name, telegram_username } = req.body;

    if (!telegram_chat_id) {
      return res.status(400).json({ error: 'Se requiere telegram_chat_id' });
    }

    const { rows } = await db.query(
      `INSERT INTO users (telegram_chat_id, name, telegram_username)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_chat_id)
       DO UPDATE SET
         name               = COALESCE(EXCLUDED.name, users.name),
         telegram_username  = COALESCE(EXCLUDED.telegram_username, users.telegram_username),
         updated_at         = NOW()
       RETURNING *`,
      [String(telegram_chat_id), name || null, telegram_username || null]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/users/telegram/:chatId
 * Busca un usuario por su Telegram chat ID.
 */
router.get('/telegram/:chatId', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE telegram_chat_id = $1',
      [req.params.chatId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/users/:userId/tickets
 * Lista los tickets activos de un usuario.
 */
router.get('/:userId/tickets', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, label, numbers_json, created_at
       FROM tickets
       WHERE user_id = $1 AND is_active = true
       ORDER BY created_at ASC`,
      [req.params.userId]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/users
 * Lista todos los usuarios activos.
 */
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, telegram_username, telegram_chat_id, is_active, created_at
       FROM users
       WHERE is_active = true
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
