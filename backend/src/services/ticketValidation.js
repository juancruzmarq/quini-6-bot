/**
 * Lógica compartida para validar tickets contra un sorteo.
 * Usado por: cron, API results (validate-tickets), bot (/testresult).
 *
 * Reglas:
 *   - Solo tickets con created_at::date <= draw_date
 *   - Único: solo si aún no tiene ningún ticket_result
 *   - Fijo: siempre que cumpla la fecha
 */

const { validateTicket } = require('./validator');

const TICKETS_FOR_DRAW_WHERE = `
  FROM tickets t
  JOIN users u ON u.id = t.user_id
  WHERE t.is_active = true AND u.is_active = true
    AND t.created_at::date <= $1
    AND (t.tipo = 'fijo' OR NOT EXISTS (SELECT 1 FROM ticket_results tr2 WHERE tr2.ticket_id = t.id))
`;

/**
 * Devuelve los tickets que participarían en un sorteo (misma lógica que cron/API).
 * @param {object} db - Módulo db (query)
 * @param {string} drawDate - Fecha del sorteo (YYYY-MM-DD)
 * @param {{ userId?: number }} [options] - Si se pasa userId, solo tickets de ese usuario
 * @returns {Promise<Array>} Filas con t.id, t.user_id, t.label, t.numbers_json, t.tipo, u.telegram_chat_id, u.name
 */
async function getTicketsToValidateForDraw(db, drawDate, options = {}) {
  const { userId } = options;
  const select = `SELECT t.id, t.user_id, t.label, t.numbers_json, t.tipo, u.telegram_chat_id, u.name ${TICKETS_FOR_DRAW_WHERE}`;
  const order = ' ORDER BY t.id';
  const sql = userId == null
    ? select + order
    : select + ' AND t.user_id = $2' + order;
  const params = userId == null ? [drawDate] : [drawDate, userId];
  const { rows } = await db.query(sql, params);
  return rows;
}

/**
 * Valida cada ticket contra el sorteo, persiste en ticket_results y devuelve conteos.
 * @param {object} db
 * @param {string} contestNumber
 * @param {{ draw_date: string, result_json: object }} drawRow
 * @param {Array} tickets - Filas de getTicketsToValidateForDraw
 * @returns {{ totalTickets: number, winnersCount: number }}
 */
async function runValidationForDraw(db, contestNumber, drawRow, tickets) {
  const drawResult = drawRow.result_json;
  const drawDate = drawRow.draw_date;
  let winnersCount = 0;

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
      [ticket.id, contestNumber, drawDate, validation.wonAny, validation.results]
    );
    if (validation.wonAny) winnersCount++;
  }

  return { totalTickets: tickets.length, winnersCount };
}

module.exports = { getTicketsToValidateForDraw, runValidationForDraw };
