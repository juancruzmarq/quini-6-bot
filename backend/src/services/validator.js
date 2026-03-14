const { formatDateDDMMYY } = require('../utils/dateFormat');

/**
 * Motor de validación de tickets contra resultados del Quini 6.
 *
 * Modalidades y reglas:
 *   - tradicional:  gana con 4, 5 o 6 aciertos
 *   - segunda:      gana con 4, 5 o 6 aciertos
 *   - revancha:     gana solo con 6 aciertos
 *   - siempre_sale: gana con 5 o 6 aciertos (Art. 29°: se premia el mayor nivel con ganadores)
 *   - pozo_extra:   los 6 números del ticket en la unión de tradicional + segunda + revancha (Art. 30°).
 *                   No participa si ya ganó en Tradicional, La Segunda o Revancha (no excluye Siempre Sale).
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
  // Art. 29°: se premia 6 aciertos; si no hay, 5 aciertos
  results.siempre_sale = checkModality(
    normalized,
    modalities.siempre_sale,
    [5, 6]
  );

  // ── Pozo Extra ─────────────────────────────────────────────────────────────
  // Art. 30°: excluidas apuestas con 6 aciertos en Tradicional, La Segunda o Revancha (no Siempre Sale)
  const wonTradSegundaRevancha = [results.tradicional, results.segunda, results.revancha].some(r => r && r.won);

  if (!wonTradSegundaRevancha) {
    results.pozo_extra = checkPozoExtra(normalized, modalities);
  } else {
    results.pozo_extra = {
      won:              false,
      reason:           'Ticket ganó en Tradicional, La Segunda o Revancha — no participa del Pozo Extra',
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

/**
 * Arma la sección "Resultados del sorteo": números ganadores y premios por modalidad.
 * @param {object} drawResult - result_json del sorteo (modalities, jackpot)
 * @returns {string[]}
 */
function formatDrawSummary(drawResult) {
  if (!drawResult || !drawResult.modalities) return [];
  const lines = [];
  if (drawResult.jackpot) {
    lines.push(`💰 *Pozo acumulado:* ${drawResult.jackpot}`, ``);
  }
  lines.push(`_Cada línea: aciertos · ganadores · pozo total · premio por ganador_`, ``);

  const fmtArsOpts = { style: 'currency', currency: 'ARS', maximumFractionDigits: 0, minimumFractionDigits: 0 };
  function formatArs(amount) {
    return new Intl.NumberFormat('es-AR', fmtArsOpts).format(amount);
  }

  function parsePrizeAmount(prizeEntry) {
    const raw = typeof prizeEntry?.prizeAmount === 'number' ? prizeEntry.prizeAmount : null;
    if (!raw) return null;
    // Si el texto original tiene coma decimal, prizeAmount viene como centavos (se parsea quitando todo excepto dígitos).
    const hasDecimalComma = typeof prizeEntry.prize === 'string' && prizeEntry.prize.includes(',');
    return hasDecimalComma ? raw / 100 : raw;
  }

  function getTotalPrizeString(p) {
    const winners = typeof p?.winners === 'number' ? p.winners : null;
    const perAmount = parsePrizeAmount(p);
    if (!perAmount) return p?.prize || '';
    if (!winners || winners <= 0) return formatArs(perAmount); // Vacante: pozo total sin centavos
    return formatArs(perAmount * winners);
  }

  const MOD_ORDER = ['tradicional', 'segunda', 'revancha', 'siempre_sale', 'pozo_extra'];
  for (const key of MOD_ORDER) {
    const mod = drawResult.modalities[key];
    if (!mod) continue;
    const icon = MODALITY_ICONS[key];
    const name = MODALITY_NAMES[key];
    if (key === 'pozo_extra') {
      lines.push(`⭐ *Pozo Extra*`);
      if (mod.prizes && mod.prizes.length) {
        for (const p of mod.prizes) {
          const g = p.winners === 0 ? 'Vacante' : String(p.winners);
          const total = getTotalPrizeString(p);
          const porGanador = !p.winners ? '' : (parsePrizeAmount(p) != null ? ` · ${formatArs(parsePrizeAmount(p))}` : '');
          lines.push(`   — · ${g} · ${total}${porGanador}`);
        }
      }
      lines.push(``);
      continue;
    }
    const nums = (mod.numbers || []).map(n => String(n).padStart(2, '0')).join(' - ');
    lines.push(`${icon} *${name}:* ${nums || '—'}`);
    if (mod.prizes && mod.prizes.length) {
      for (const p of mod.prizes) {
        const g = p.winners === 0 ? 'Vacante' : String(p.winners);
        const total = getTotalPrizeString(p);
        const porGanador = !p.winners ? '' : (parsePrizeAmount(p) != null ? ` · ${formatArs(parsePrizeAmount(p))}` : '');
        lines.push(`   ${p.hits} · ${g} · ${total}${porGanador}`);
      }
    }
    lines.push(``);
  }
  return lines;
}

/**
 * Construye el mensaje de "tus resultados" para un usuario: resultados del sorteo
 * (números y premios por modalidad) + todos sus tickets con el desglose (aciertos y si ganó).
 *
 * @param {string} contestNumber
 * @param {string} dateStr - Fecha en DD/MM/YY
 * @param {Array<{ label?: string, numbers_json: string[], tipo?: string, results_json: object, won_any_prize: boolean }>} ticketsWithResults
 * @param {object} [drawResult] - result_json del sorteo (opcional); si se pasa, se incluye resumen del sorteo
 * @returns {string}
 */
function buildUserResultsMessage(contestNumber, dateStr, ticketsWithResults, drawResult) {
  const anyWin = (ticketsWithResults || []).some(t => t && t.won_any_prize);
  const lines = anyWin
    ? [
      `🎉 *¡Felicitaciones! Tenés un ticket ganador*`,
      `📊 *Sorteo N° ${contestNumber}* (${dateStr})`,
      ``,
    ]
    : [
      `📊 *Tus resultados — Sorteo N° ${contestNumber}* (${dateStr})`,
      ``,
    ];

  const drawSummary = formatDrawSummary(drawResult);
  if (drawSummary.length) {
    lines.push(...drawSummary);
    lines.push(`━━━━━━━━━━━━━━━━━━`, `*Tus tickets*`, ``);
  } else {
    lines.push(`*Tus tickets*`, ``);
  }

  const MOD_ORDER = ['tradicional', 'segunda', 'revancha', 'siempre_sale', 'pozo_extra'];

  function formatPrizeYouReceive(prizeEntry) {
    if (!prizeEntry) return '';
    if (prizeEntry.prizePerWinner) return prizeEntry.prizePerWinner;

    const winners = typeof prizeEntry.winners === 'number' ? prizeEntry.winners : null;
    const amountRaw = typeof prizeEntry.prizeAmount === 'number' ? prizeEntry.prizeAmount : null;
    if (!winners || winners <= 0 || !amountRaw) return prizeEntry.prize || '';

    // Heurística: si el texto original tiene coma decimal, prizeAmount viene como centavos (parseMoneyString quita todo excepto dígitos).
    const hasDecimalComma = typeof prizeEntry.prize === 'string' && prizeEntry.prize.includes(',');
    const total = hasDecimalComma ? amountRaw / 100 : amountRaw;
    const perWinner = total / winners;

    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(perWinner);
  }

  for (let i = 0; i < ticketsWithResults.length; i++) {
    const t = ticketsWithResults[i];
    const nums = (t.numbers_json || []).map(n => String(n).padStart(2, '0')).join(' - ');
    const labelPart = t.label ? ` — _${t.label}_` : '';
    const tipoText = t.tipo === 'unico' ? 'Único' : (t.tipo === 'fijo' ? 'Fijo' : null);
    const tipoPart = tipoText ? ` (${tipoText})` : '';
    const winBadge = t.won_any_prize ? ' | *GANADOR !!!!!!* 🎉 🎉' : '';
    if (i > 0) lines.push(``);
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`🎱 *Ticket ${i + 1}${tipoPart}${winBadge}*${labelPart}`);
    lines.push(`   ${nums}`);
    if (t.created_at) {
      lines.push(`   📅 Alta: ${formatDateDDMMYY(t.created_at)}`);
    }
    const r = t.results_json || {};
    for (const key of MOD_ORDER) {
      const res = r[key];
      if (!res) continue;
      const icon = MODALITY_ICONS[key];
      const name = MODALITY_NAMES[key];
      if (key === 'pozo_extra') {
        if (res.reason) {
          lines.push(`   ${icon} ${name}: No participa (ganaste en otra)`);
        } else if (res.won) {
          lines.push(`   ${icon} ${name}: 6 en la unión — 🏆 *Ganaste*`);
        } else {
          const inUnion = res.matched ? res.matched.length : 0;
          lines.push(`   ${icon} ${name}: ${inUnion} en la unión — No ganó`);
        }
      } else {
        const hits = res.hits != null ? res.hits : 0;
        if (res.won && res.prize) {
          const money = formatPrizeYouReceive(res.prize);
          lines.push(`   ${icon} ${name}: ${hits} aciertos — 🏆 *Ganaste*${money ? ` (${money})` : ''}`);
        } else {
          lines.push(`   ${icon} ${name}: ${hits} aciertos`);
        }
      }
    }
    lines.push(``);
  }

  return lines.join('\n').trim();
}

module.exports = { validateTicket, buildWinnerMessage, buildUserResultsMessage };
