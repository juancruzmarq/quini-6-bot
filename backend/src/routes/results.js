const express  = require('express');
const db       = require('../db');
const { fetchAndParseLatest, fetchDebugInfo } = require('../services/parser');
const { validateTicket }                      = require('../services/validator');

const router = express.Router();

/**
 * POST /api/results/fetch-and-save
 * Descarga el HTML del sitio, parsea y guarda el resultado.
 * n8n llama a este endpoint para iniciar el ciclo.
 */
router.post('/fetch-and-save', async (req, res, next) => {
  try {
    const parsed = await fetchAndParseLatest();

    if (!parsed.contestNumber || !parsed.drawDate) {
      return res.status(422).json({
        success:  false,
        error:    'No se pudo extraer número de concurso o fecha del sorteo',
        warnings: parsed._warnings || [],
        debug:    parsed._debug,
      });
    }

    // Verificar si ya existe este sorteo
    const existing = await db.query(
      'SELECT id FROM quini_results WHERE contest_number = $1',
      [parsed.contestNumber]
    );

    if (existing.rows.length > 0) {
      return res.json({
        success:       true,
        alreadyExists: true,
        contestNumber: parsed.contestNumber,
        drawDate:      parsed.drawDate,
        message:       `Sorteo ${parsed.contestNumber} ya estaba guardado`,
      });
    }

    // Guardar en DB (sin _debug para no contaminar el JSON guardado)
    const { _debug, _warnings, ...cleanParsed } = parsed;

    await db.query(
      `INSERT INTO quini_results (contest_number, draw_date, result_json)
       VALUES ($1, $2, $3)`,
      [parsed.contestNumber, parsed.drawDate, cleanParsed]
    );

    console.log(`✅ Sorteo ${parsed.contestNumber} (${parsed.drawDate}) guardado`);

    res.json({
      success:       true,
      alreadyExists: false,
      contestNumber: parsed.contestNumber,
      drawDate:      parsed.drawDate,
      result:        cleanParsed,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/results/latest
 * Retorna el último sorteo guardado en la DB.
 */
router.get('/latest', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM quini_results ORDER BY draw_date DESC LIMIT 1'
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'No hay resultados guardados todavía' });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/results
 * Lista todos los sorteos guardados.
 */
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, contest_number, draw_date, created_at FROM quini_results ORDER BY draw_date DESC'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/results/:contestNumber
 * Retorna un sorteo específico.
 */
router.get('/:contestNumber', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM quini_results WHERE contest_number = $1',
      [req.params.contestNumber]
    );

    if (!rows.length) {
      return res.status(404).json({ error: `Sorteo ${req.params.contestNumber} no encontrado` });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/results/:contestNumber/validate-tickets
 * Valida todos los tickets activos contra el sorteo indicado.
 * n8n llama a este endpoint después de guardar el resultado.
 */
router.post('/:contestNumber/validate-tickets', async (req, res, next) => {
  try {
    const { contestNumber } = req.params;

    // Obtener el resultado del sorteo
    const drawRes = await db.query(
      'SELECT * FROM quini_results WHERE contest_number = $1',
      [contestNumber]
    );

    if (!drawRes.rows.length) {
      return res.status(404).json({
        success: false,
        error:   `Sorteo ${contestNumber} no encontrado en la DB`,
      });
    }

    const draw       = drawRes.rows[0];
    const drawResult = draw.result_json;

    // Obtener todos los tickets activos con info del usuario
    const ticketsRes = await db.query(
      `SELECT t.id, t.user_id, t.label, t.numbers_json,
              u.telegram_chat_id, u.name, u.telegram_username
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.is_active = true AND u.is_active = true`
    );

    const tickets = ticketsRes.rows;
    let   winners = 0;

    for (const ticket of tickets) {
      // Saltar si ya se validó este ticket para este sorteo
      const alreadyDone = await db.query(
        'SELECT id FROM ticket_results WHERE ticket_id = $1 AND contest_number = $2',
        [ticket.id, contestNumber]
      );
      if (alreadyDone.rows.length > 0) continue;

      const validation = validateTicket(ticket.numbers_json, drawResult);

      await db.query(
        `INSERT INTO ticket_results
           (ticket_id, contest_number, draw_date, won_any_prize, results_json)
         VALUES ($1, $2, $3, $4, $5)`,
        [ticket.id, contestNumber, draw.draw_date, validation.wonAny, validation.results]
      );

      if (validation.wonAny) winners++;
    }

    console.log(`✅ Validación sorteo ${contestNumber}: ${tickets.length} tickets, ${winners} ganadores`);

    res.json({
      success:       true,
      contestNumber,
      totalTickets:  tickets.length,
      winnersCount:  winners,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/results/:contestNumber/ticket-results
 * Retorna los resultados de tickets para un sorteo.
 * Query param: wonOnly=true para solo ganadores.
 */
router.get('/:contestNumber/ticket-results', async (req, res, next) => {
  try {
    const { contestNumber } = req.params;
    const wonOnly           = req.query.wonOnly === 'true';

    const params = [contestNumber];
    let   where  = 'tr.contest_number = $1';

    if (wonOnly) {
      where += ' AND tr.won_any_prize = true';
    }

    const { rows } = await db.query(
      `SELECT tr.*, t.numbers_json, t.label,
              u.name, u.telegram_chat_id, u.telegram_username
       FROM ticket_results tr
       JOIN tickets t ON t.id = tr.ticket_id
       JOIN users   u ON u.id = t.user_id
       WHERE ${where}
       ORDER BY tr.created_at DESC`,
      params
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/results/debug-parse
 * Descarga el HTML del sitio y retorna el resultado parseado + HTML crudo.
 * Útil para ajustar el parser si el sitio cambia su estructura.
 */
router.get('/debug/parse', async (_req, res, next) => {
  try {
    const { html, parsed } = await fetchDebugInfo();
    res.json({
      url:        'https://www.quini-6-resultados.com.ar/',
      htmlLength: html.length,
      htmlSnippet: html.substring(0, 2000),
      parsed,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
