const { formatDateDDMMYY } = require('../utils/dateFormat');

/**
 * Motor de validación de tickets contra resultados del Quini 6.
 *
 * Modalidades y reglas:
 *   - tradicional:  gana con 4, 5 o 6 aciertos
 *   - segunda:      gana con 4, 5 o 6 aciertos
 *   - revancha:     gana solo con 6 aciertos
 *   - siempre_sale: gana solo con 5 aciertos
 *   - pozo_extra:   los 6 números del ticket deben estar dentro de la unión
 *                   de los números de tradicional + segunda + revancha,
 *                   y el ticket NO debe haber ganado en ninguna otra modalidad.
 */

/**
 * Valida un ticket contra un resultado de sorteo.
 *
 * @param {string[]} ticketNumbers - Array de 6 números (ej: ["09","11","12","14","18","20"])
 * @param {object}   drawResult    - Objeto result_json de quini_results
 * @returns {{ wonAny: boolean, results: object }}
 */
function validateTicket(ticketNumbers, drawResult) {
  const normalized = ticketNumbers.map(n => String(n).padStart(2, '0'));
  const results    = {};

  const { modalities = {} } = drawResult;

  // ── Tradicional ────────────────────────────────────────────────────────────
  results.tradicional = checkModality(
    normalized,
    modalities.tradicional,
    [4, 5, 6]
  );

  // ── Segunda ────────────────────────────────────────────────────────────────
  results.segunda = checkModality(
    normalized,
    modalities.segunda,
    [4, 5, 6]
  );

  // ── Revancha ───────────────────────────────────────────────────────────────
  results.revancha = checkModality(
    normalized,
    modalities.revancha,
    [6]
  );

  // ── Siempre Sale ───────────────────────────────────────────────────────────
  results.siempre_sale = checkModality(
    normalized,
    modalities.siempre_sale,
    [5]
  );

  // ── Pozo Extra ─────────────────────────────────────────────────────────────
  // Solo participa si NO ganó en ninguna otra modalidad
  const wonOtherModality = Object.values(results).some(r => r.won);

  if (!wonOtherModality) {
    results.pozo_extra = checkPozoExtra(normalized, modalities);
  } else {
    results.pozo_extra = {
      won:              false,
      reason:           'Ticket ganó en otra modalidad — no participa del Pozo Extra',
      inUnion:          false,
      unionSize:        0,
    };
  }

  const wonAny = Object.values(results).some(r => r.won);

  return { wonAny, results };
}

/**
 * Compara el ticket contra una modalidad específica.
 */
function checkModality(ticketNumbers, modalityData, winningHits) {
  if (!modalityData || !Array.isArray(modalityData.numbers)) {
    return { won: false, hits: 0, reason: 'Modalidad sin datos' };
  }

  const winningNumbers = modalityData.numbers.map(n => String(n).padStart(2, '0'));
  const matchingNums   = ticketNumbers.filter(n => winningNumbers.includes(n));
  const hits           = matchingNums.length;
  const won            = winningHits.includes(hits);

  const result = { won, hits, matchingNumbers: matchingNums };

  if (won && modalityData.prizes) {
    const prizeEntry = modalityData.prizes.find(
      p => parseInt(p.hits) === hits
    );
    if (prizeEntry) result.prize = prizeEntry;
  }

  return result;
}

/**
 * Verifica si el ticket gana el Pozo Extra.
 * Condición: los 6 números del ticket deben estar en la unión
 * de los números de tradicional + segunda + revancha.
 */
function checkPozoExtra(ticketNumbers, modalities) {
  const unionSet = new Set([
    ...(modalities.tradicional?.numbers || []).map(n => n.padStart(2, '0')),
    ...(modalities.segunda?.numbers     || []).map(n => n.padStart(2, '0')),
    ...(modalities.revancha?.numbers    || []).map(n => n.padStart(2, '0')),
  ]);

  const inUnion  = ticketNumbers.filter(n => unionSet.has(n));
  const allMatch = inUnion.length === ticketNumbers.length;

  return {
    won:       allMatch,
    inUnion:   allMatch,
    unionSize: unionSet.size,
    matched:   inUnion,
    missing:   ticketNumbers.filter(n => !unionSet.has(n)),
  };
}

/**
 * Construye el mensaje de Telegram para notificar un premio.
 *
 * @param {object} user             - Fila de la tabla users
 * @param {object} ticket           - { label, numbers_json }
 * @param {string} contestNumber
 * @param {string} drawDateRaw
 * @param {object} validationResult - { wonAny, results }
 * @param {object} drawResult       - result_json del sorteo (para mostrar todos los números)
 * @returns {string}
 */
function buildWinnerMessage(user, ticket, contestNumber, drawDateRaw, validationResult, drawResult) {
  const { results } = validationResult;
  const ticketNums  = ticket.numbers_json.map(n => String(n).padStart(2, '0'));
  const label       = ticket.label ? ` — _${ticket.label}_` : '';

  const lines = [
    `🎉 *¡Ganaste en el Quini 6!*`,
    `📅 Sorteo N° ${contestNumber} — ${formatDateDDMMYY(drawDateRaw)}`,
  ];

  if (drawResult?.jackpot) {
    lines.push(`💰 Pozo acumulado: ${drawResult.jackpot}`);
  }

  // ── Sección: resultados del sorteo ─────────────────────────────────────────
  lines.push(``, `━━━━━━━━━━━━━━━━━━`, `📊 *Resultados del sorteo*`, ``);

  const DRAW_ORDER = ['tradicional', 'segunda', 'revancha', 'siempre_sale'];
  const modalities = drawResult?.modalities || {};

  for (const key of DRAW_ORDER) {
    const mod = modalities[key];
    if (!mod?.numbers?.length) continue;
    const icon = MODALITY_ICONS[key];
    const name = MODALITY_NAMES[key];
    const nums = mod.numbers.map(n => n.padStart(2, '0')).join(' - ');

    lines.push(`${icon} *${name}*`);
    lines.push(`   🎱 ${nums}`);

    if (mod.prizes?.length) {
      for (const p of mod.prizes) {
        const ganadores = p.winners === 0
          ? 'Vacante'
          : `${p.winners} ganador${p.winners !== 1 ? 'es' : ''}`;
        lines.push(`   ${p.hits} aciertos → ${ganadores} | ${p.prize}`);
      }
    }

    lines.push('');
  }

  // ── Sección: tu ticket ──────────────────────────────────────────────────────
  lines.push(
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `🎱 *Tu ticket${label}*`,
    ticketNums.join(' - '),
    ``
  );

  // ── Sección: coincidencias por modalidad ────────────────────────────────────
  lines.push(`*Coincidencias:*`, ``);

  const ALL_MODALITIES = ['tradicional', 'segunda', 'revancha', 'siempre_sale', 'pozo_extra'];

  for (const key of ALL_MODALITIES) {
    const r    = results[key];
    const mod  = modalities[key];
    if (!r) continue;

    const icon = MODALITY_ICONS[key];
    const name = MODALITY_NAMES[key];

    if (r.won) {
      // Modalidad ganada → mostrar cada número con ✅ o ☑️
      const winningSet = new Set((mod?.numbers || []).map(n => n.padStart(2, '0')));
      const numsDisplay = ticketNums.map(n => winningSet.has(n) ? `✅${n}` : `▫️${n}`).join('  ');
      const hitsLabel   = r.hits !== undefined ? ` — *${r.hits} aciertos*` : '';
      const prizeLabel  = r.prize?.prize ? `\n   💵 Premio: ${r.prize.prize} (${r.prize.winners} ganador${r.prize.winners !== 1 ? 'es' : ''})` : '';
      lines.push(`${icon} *${name}*${hitsLabel}`, `   ${numsDisplay}${prizeLabel}`, ``);
    } else if (key !== 'pozo_extra' && r.hits >= 2) {
      // No ganó pero tuvo 2+ aciertos parciales → vale la pena mostrar
      const winningSet  = new Set((mod?.numbers || []).map(n => n.padStart(2, '0')));
      const numsDisplay = ticketNums.map(n => winningSet.has(n) ? `☑️${n}` : `▫️${n}`).join('  ');
      lines.push(`${icon} ${name} — ${r.hits} aciertos`, `   ${numsDisplay}`, ``);
    }
  }

  return lines.join('\n').trim();
}

const MODALITY_NAMES = {
  tradicional:  'Tradicional',
  segunda:      'La Segunda',
  revancha:     'Revancha',
  siempre_sale: 'Siempre Sale',
  pozo_extra:   'Pozo Extra',
};

const MODALITY_ICONS = {
  tradicional:  '🔵',
  segunda:      '🟢',
  revancha:     '🔴',
  siempre_sale: '🟡',
  pozo_extra:   '⭐',
};

module.exports = { validateTicket, buildWinnerMessage };
