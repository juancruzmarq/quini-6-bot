const express = require('express');
const db      = require('../db');
const { buildWinnerMessage } = require('../services/validator');

const router = express.Router();

/**
 * POST /api/notifications/notify-winners
 * Envía mensajes de Telegram a todos los ganadores de un sorteo.
 * n8n llama a este endpoint después de validar los tickets.
 *
 * Body: { contestNumber }
 */
router.post('/notify-winners', async (req, res, next) => {
  try {
    const { contestNumber } = req.body;

    if (!contestNumber) {
      return res.status(400).json({ error: 'Se requiere contestNumber' });
    }

    // Verificar que el bot esté disponible
    const bot = getBotInstance();
    if (!bot) {
      return res.status(503).json({
        error: 'Bot de Telegram no configurado (falta TELEGRAM_BOT_TOKEN)',
      });
    }

    // Obtener datos del sorteo
    const drawRes = await db.query(
      'SELECT * FROM quini_results WHERE contest_number = $1',
      [contestNumber]
    );

    if (!drawRes.rows.length) {
      return res.status(404).json({ error: `Sorteo ${contestNumber} no encontrado` });
    }

    const draw = drawRes.rows[0];

    // Obtener ganadores con datos de ticket y usuario
    const winnersRes = await db.query(
      `SELECT tr.results_json,
              t.id AS ticket_id, t.label, t.numbers_json,
              u.telegram_chat_id, u.name
       FROM ticket_results tr
       JOIN tickets t ON t.id = tr.ticket_id
       JOIN users   u ON u.id = t.user_id
       WHERE tr.contest_number = $1 AND tr.won_any_prize = true`,
      [contestNumber]
    );

    const winners  = winnersRes.rows;
    let   notified = 0;
    const errors   = [];

    for (const winner of winners) {
      try {
        const drawDateRaw = draw.result_json?.drawDateRaw || draw.draw_date;
        const message     = buildWinnerMessage(
          { name: winner.name, telegram_chat_id: winner.telegram_chat_id },
          { label: winner.label, numbers_json: winner.numbers_json },
          contestNumber,
          drawDateRaw,
          { wonAny: true, results: winner.results_json },
          draw.result_json
        );

        await bot.sendMessage(winner.telegram_chat_id, message, {
          parse_mode: 'Markdown',
        });

        notified++;
      } catch (err) {
        console.error(`Error notificando a ${winner.telegram_chat_id}:`, err.message);
        errors.push({ chatId: winner.telegram_chat_id, error: err.message });
      }
    }

    console.log(`📨 Notificaciones sorteo ${contestNumber}: ${notified}/${winners.length} enviadas`);

    res.json({
      success:        true,
      contestNumber,
      totalWinners:   winners.length,
      notified,
      errors,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/notifications/test
 * Envía un mensaje de prueba a un chat ID específico.
 * Body: { chatId, message? }
 */
router.post('/test', async (req, res, next) => {
  try {
    const { chatId, message } = req.body;

    if (!chatId) {
      return res.status(400).json({ error: 'Se requiere chatId' });
    }

    const bot = getBotInstance();
    if (!bot) {
      return res.status(503).json({ error: 'Bot no configurado' });
    }

    await bot.sendMessage(chatId, message || '✅ Mensaje de prueba del sistema Quini 6');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Acceso a la instancia del bot ─────────────────────────────────────────────

let _botInstance = null;

function setBotInstance(bot) {
  _botInstance = bot;
}

function getBotInstance() {
  return _botInstance;
}

module.exports        = router;
module.exports.setBotInstance = setBotInstance;
