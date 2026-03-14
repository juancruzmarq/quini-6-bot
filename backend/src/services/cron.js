/**
 * Scheduler de sorteos del Quini 6
 *
 * Lógica de ejecución (miércoles y domingos):
 *
 *   21:15 → 21:55  Intento cada 5 minutos de obtener el resultado.
 *                  Si ya está guardado, el intento se saltea silenciosamente.
 *                  Si se obtiene, valida tickets y notifica ganadores.
 *
 *   22:00          Verificación final: si todavía no se obtuvo el resultado
 *                  del día, envía alerta al admin por Telegram.
 *
 * También expone runFullCycle() para ejecución manual vía API o comando admin.
 */

const cron = require('node-cron');
const db   = require('../db');
const log  = require('../logger');
const { formatDateDDMMYY }   = require('../utils/dateFormat');
const { fetchAndParseLatest } = require('./parser');
const { validateTicket, buildUserResultsMessage } = require('./validator');

// ── Configuración ─────────────────────────────────────────────────────────────

// Cron 1: cada 5 min de 21:15 a 21:55 los mié y dom
const SCHEDULE_POLLING = '15,20,25,30,35,40,45,50,55 21 * * 0,3';

// Cron 2: a las 22:00 los mié y dom — alerta si no se obtuvo el resultado
const SCHEDULE_ALERT   = '0 22 * * 0,3';

// Cron 3: martes y sábado 20:00 — recordatorio "mañana es sorteo"
const SCHEDULE_REMINDER = '0 20 * * 2,6';

const TZ = 'America/Argentina/Buenos_Aires';

let _botInstance    = null;
let _adminChatId    = null;

function setBotForCron(bot) {
  _botInstance = bot;
}

function setAdminChatId(chatId) {
  _adminChatId = chatId ? String(chatId) : null;
}

// ── Ciclo completo ────────────────────────────────────────────────────────────

/**
 * Intenta obtener, guardar, validar y notificar el último sorteo.
 * Si el sorteo ya estaba guardado, retorna inmediatamente (idempotente).
 *
 * @param {object} opts
 * @param {boolean} opts.silent  Si true, no loguea "ya estaba guardado"
 * @returns {object} resultado del ciclo
 */
async function runFullCycle({ silent = false } = {}) {
  const startedAt = new Date().toISOString();
  const result = { startedAt, fetchResult: null, validateResult: null, notifyResult: null, error: null };

  try {
    // ── Paso 1: Fetch y parseo ────────────────────────────────────────────────
    if (!silent) log.cron.info({ startedAt }, 'Iniciando ciclo');

    const parsed = await fetchAndParseLatest();

    if (!parsed.contestNumber || !parsed.drawDate) {
      const msg = `Parser no extrajo datos (warnings: ${(parsed._warnings || []).join(', ')})`;
      log.cron.error({ warnings: parsed._warnings }, msg);
      result.error = msg;
      return result;
    }

    // ── Verificar si ya existe ────────────────────────────────────────────────
    const existing = await db.query(
      'SELECT id FROM quini_results WHERE contest_number = $1',
      [parsed.contestNumber]
    );

    if (existing.rows.length > 0) {
      if (!silent) log.cron.info({ contestNumber: parsed.contestNumber }, 'Sorteo ya guardado — sin cambios');
      result.fetchResult = { alreadyExists: true, contestNumber: parsed.contestNumber };
      return result;
    }

    // ── Guardar resultado ─────────────────────────────────────────────────────
    const { _debug, _warnings, ...cleanParsed } = parsed;
    await db.query(
      `INSERT INTO quini_results (contest_number, draw_date, result_json) VALUES ($1, $2, $3)`,
      [parsed.contestNumber, parsed.drawDate, cleanParsed]
    );
    log.cron.info({ contestNumber: parsed.contestNumber, drawDate: parsed.drawDate }, 'Sorteo guardado');
    result.fetchResult = { alreadyExists: false, contestNumber: parsed.contestNumber, drawDate: parsed.drawDate };

    const contestNumber = parsed.contestNumber;

    // ── Paso 2: Validar tickets ───────────────────────────────────────────────
    log.cron.info({ contestNumber }, 'Validando tickets...');

    const drawRow    = (await db.query('SELECT * FROM quini_results WHERE contest_number = $1', [contestNumber])).rows[0];
    const drawResult = drawRow.result_json;

    const tickets = (await db.query(
      `SELECT t.id, t.user_id, t.label, t.numbers_json,
              u.telegram_chat_id, u.name
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.is_active = true AND u.is_active = true`
    )).rows;

    let winners = 0;
    for (const ticket of tickets) {
      const already = await db.query(
        'SELECT id FROM ticket_results WHERE ticket_id = $1 AND contest_number = $2',
        [ticket.id, contestNumber]
      );
      if (already.rows.length > 0) continue;

      const validation = validateTicket(ticket.numbers_json, drawResult);
      await db.query(
        `INSERT INTO ticket_results (ticket_id, contest_number, draw_date, won_any_prize, results_json)
         VALUES ($1, $2, $3, $4, $5)`,
        [ticket.id, contestNumber, drawRow.draw_date, validation.wonAny, validation.results]
      );
      if (validation.wonAny) winners++;
    }

    log.cron.info({ totalTickets: tickets.length, winners, contestNumber }, 'Tickets validados');
    result.validateResult = { totalTickets: tickets.length, winnersCount: winners };

    // ── Paso 3: Enviar a cada usuario sus resultados (todos sus tickets y modalidades) ─
    if (!_botInstance) {
      log.cron.warn('Bot no disponible — saltando notificaciones');
      result.notifyResult = { notified: 0, reason: 'bot no disponible' };
    } else {
      const dateStr = formatDateDDMMYY(drawResult.drawDateRaw || drawRow.draw_date);
      const rows    = (await db.query(
        `SELECT u.telegram_chat_id, u.name, t.id AS ticket_id, t.label, t.numbers_json, tr.results_json, tr.won_any_prize
         FROM ticket_results tr
         JOIN tickets t ON t.id = tr.ticket_id
         JOIN users   u ON u.id = t.user_id
         WHERE tr.contest_number = $1 AND u.is_active = true
         ORDER BY u.telegram_chat_id, t.id`,
        [contestNumber]
      )).rows;

      const byUser = new Map();
      for (const r of rows) {
        const chatId = r.telegram_chat_id;
        if (!byUser.has(chatId)) byUser.set(chatId, []);
        byUser.get(chatId).push({
          label:         r.label,
          numbers_json:  r.numbers_json,
          results_json:  r.results_json,
          won_any_prize: r.won_any_prize,
        });
      }

      let notified = 0;
      for (const [chatId, userTickets] of byUser) {
        try {
          const message = buildUserResultsMessage(contestNumber, dateStr, userTickets, drawResult);
          await _botInstance.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          notified++;
        } catch (err) {
          log.cron.error({ chatId, err: err.message }, 'Error enviando resultados al usuario');
        }
      }
      log.cron.info({ contestNumber, notified, totalUsers: byUser.size }, 'Resultados enviados por usuario');
      result.notifyResult = { notified, totalUsers: byUser.size };
    }

  } catch (err) {
    log.cron.error({ err: err.message }, 'Error en el ciclo');
    result.error = err.message;
  }

  return result;
}

// ── Verificación de alerta a las 22:00 ───────────────────────────────────────

/**
 * Verifica si ya se obtuvo el resultado del sorteo de hoy.
 * Si no está en la DB, envía una alerta al admin por Telegram.
 */
async function runAlertCheck() {
  log.cron.info('Verificación 22:00');

  const today = new Date().toISOString().slice(0, 10);

  const { rows } = await db.query(
    'SELECT id, contest_number FROM quini_results WHERE draw_date = $1',
    [today]
  );

  if (rows.length > 0) {
    log.cron.info({ contestNumber: rows[0].contest_number }, 'Resultado ya guardado — OK');
    return;
  }

  log.cron.warn({ date: today }, 'No se obtuvo resultado — enviando alerta al admin');

  if (!_botInstance || !_adminChatId) {
    log.cron.warn('No se puede enviar alerta: bot o ADMIN_TELEGRAM_ID no configurado');
    return;
  }

  try {
    await _botInstance.sendMessage(
      _adminChatId,
      [
        `⚠️ *Alerta Quini 6*`,
        ``,
        `No se pudo obtener el resultado del sorteo del día *${today}*.`,
        ``,
        `El sitio puede estar caído o la estructura HTML cambió.`,
        ``,
        `Podés forzarlo manualmente con:`,
        `/runcycle`,
      ].join('\n'),
      { parse_mode: 'Markdown' }
    );
    log.cron.info('Alerta enviada al admin');
  } catch (err) {
    log.cron.error({ err: err.message }, 'Error enviando alerta al admin');
  }
}

// ── Inicialización ────────────────────────────────────────────────────────────

function initializeCron() {
  // Job 1: polling cada 5 minutos de 21:15 a 21:55
  cron.schedule(SCHEDULE_POLLING, () => {
    runFullCycle({ silent: false }).catch(err =>
      log.cron.error({ err: err.message }, 'Error no capturado en polling')
    );
  }, { timezone: TZ });

  cron.schedule(SCHEDULE_ALERT, () => {
    runAlertCheck().catch(err =>
      log.cron.error({ err: err.message }, 'Error no capturado en alerta')
    );
  }, { timezone: TZ });

  cron.schedule(SCHEDULE_REMINDER, () => {
    runReminders().catch(err =>
      log.cron.error({ err: err.message }, 'Error en recordatorios')
    );
  }, { timezone: TZ });

  log.cron.info({ timezone: TZ, polling: SCHEDULE_POLLING, alert: SCHEDULE_ALERT, reminder: SCHEDULE_REMINDER }, 'Cron activo');
}

// ── Recordatorios ─────────────────────────────────────────────────────────────

async function runReminders() {
  if (!_botInstance) return;
  try {
    const { rows } = await db.query(
      `SELECT telegram_chat_id FROM users WHERE is_active = true AND COALESCE(reminder_enabled, true) = true`
    );
    const msg = '📅 *Recordatorio Quini 6*\n\nMañana es sorteo a las 21:15 hs. ¿Ya tenés tus números?\n\n_Podés desactivar estos avisos con_ /recordar';
    for (const u of rows) {
      try {
        await _botInstance.sendMessage(u.telegram_chat_id, msg, { parse_mode: 'Markdown' });
      } catch (err) {
        log.cron.error({ chatId: u.telegram_chat_id, err: err.message }, 'Error enviando recordatorio');
      }
    }
    log.cron.info({ count: rows.length }, rows.length === 0 ? 'Recordatorios: 0 usuarios activos' : 'Recordatorios enviados');
  } catch (err) {
    if (err.code === '42703') return; // column reminder_enabled no existe aún
    throw err;
  }
}

module.exports = { initializeCron, runFullCycle, setBotForCron, setAdminChatId };
