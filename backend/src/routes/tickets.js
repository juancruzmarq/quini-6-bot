const express = require('express');
const db      = require('../db');

const router = express.Router();

/**
 * GET /api/tickets
 * Lista todos los tickets activos (usado por el proceso de validación).
 * Query: userId para filtrar por usuario.
 */
router.get('/', async (req, res, next) => {
  try {
    const { userId } = req.query;
    const params     = [];
    let   where      = 'is_active = true';

    if (userId) {
      params.push(userId);
      where += ` AND user_id = $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT t.id, t.user_id, t.label, t.numbers_json, t.created_at,
              u.name, u.telegram_username
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE ${where}
       ORDER BY t.created_at DESC`,
      params
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tickets
 * Crea un nuevo ticket.
 * Body: { user_id, numbers, label?, tipo? } — tipo: 'unico' (próximo sorteo) o 'fijo' (todos los sorteos). Default 'fijo'.
 */
router.post('/', async (req, res, next) => {
  try {
    const { user_id, numbers, label, tipo } = req.body;

    if (!user_id || !numbers) {
      return res.status(400).json({ error: 'Se requiere user_id y numbers' });
    }

    const normalized = validateAndNormalizeNumbers(numbers);
    if (!normalized.valid) {
      return res.status(400).json({ error: normalized.error });
    }

    const ticketTipo = (tipo === 'unico' || tipo === 'fijo') ? tipo : 'fijo';

    const { rows } = await db.query(
      `INSERT INTO tickets (user_id, label, numbers_json, tipo)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [user_id, label || null, JSON.stringify(normalized.numbers), ticketTipo]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/tickets/:id
 * Desactiva (soft delete) un ticket.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE tickets SET is_active = false, updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Ticket no encontrado' });
    }

    res.json({ success: true, deleted: rows[0].id });
  } catch (err) {
    next(err);
  }
});

// ── Helper de validación ───────────────────────────────────────────────────────

function validateAndNormalizeNumbers(numbers) {
  let arr = numbers;

  if (typeof numbers === 'string') {
    arr = numbers.split(',').map(n => n.trim());
  }

  if (!Array.isArray(arr)) {
    return { valid: false, error: 'numbers debe ser un array o string separado por comas' };
  }

  if (arr.length !== 6) {
    return { valid: false, error: `Se requieren exactamente 6 números (se recibieron ${arr.length})` };
  }

  const normalized = [];
  for (const n of arr) {
    const num = parseInt(n, 10);
    if (isNaN(num) || num < 0 || num > 45) {
      return { valid: false, error: `Número inválido: ${n} (debe estar entre 0 y 45)` };
    }
    normalized.push(String(num).padStart(2, '0'));
  }

  const unique = new Set(normalized);
  if (unique.size !== 6) {
    return { valid: false, error: 'Los 6 números deben ser distintos' };
  }

  return { valid: true, numbers: normalized };
}

module.exports = router;
module.exports.validateAndNormalizeNumbers = validateAndNormalizeNumbers;
