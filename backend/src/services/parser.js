/**
 * Parser de resultados del Quini 6
 * Fuente: https://www.quini-6-resultados.com.ar/
 *
 * Estrategia: extrae datos usando regex sobre el texto del body,
 * ya que el sitio tiene un formato de texto consistente.
 *
 * Si el sitio cambia su estructura, usá el endpoint
 * GET /api/results/debug/parse para ver el texto crudo y ajustar los patrones.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const log     = require('../logger');

const QUINI_URL = 'https://www.quini-6-resultados.com.ar/';

const HTTP_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
  'Cache-Control':   'no-cache',
};

async function fetchHTML() {
  const response = await axios.get(QUINI_URL, {
    timeout: 20000,
    headers: HTTP_HEADERS,
  });
  return response.data;
}

/**
 * Parsea el HTML del sitio y retorna el resultado estructurado.
 */
function parseQuiniHTML(html) {
  const $        = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  const debug = { bodyTextSnippet: bodyText.substring(0, 500) };

  // ── Número de concurso ──────────────────────────────────────────────────────
  const contestMatch = bodyText.match(/Nro\.?\s*Sorteo:\s*(\d{3,5})/i);
  const contestNumber = contestMatch ? contestMatch[1] : null;

  // ── Fecha del sorteo ────────────────────────────────────────────────────────
  const dateMatch = bodyText.match(/Sorteo del dia\s+(\d{1,2}\/\d{2}\/\d{4})/i)
                 || bodyText.match(/(\d{1,2}\/\d{2}\/\d{4})/);
  let drawDate    = null;
  let drawDateRaw = null;

  if (dateMatch) {
    drawDateRaw = dateMatch[1];
    const [day, month, year] = drawDateRaw.split('/');
    drawDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // ── Jackpot acumulado (próximo sorteo) ──────────────────────────────────────
  // El sitio muestra "POZO ACUMULADO: $4.400.000.000"
  const jackpotMatch = bodyText.match(/POZO ACUMULADO:\s*\$([\d\.,]+)/i);
  const jackpot       = jackpotMatch ? `$${jackpotMatch[1]}` : null;
  const jackpotAmount = jackpot ? parseMoneyString(jackpot) : 0;

  // ── Números ganadores por modalidad ──────────────────────────────────────────
  // El sitio tiene el formato: "TRADICIONAL09 - 11 - 12 - 14 - 18 - 20LA SEGUNDA..."
  const modalities = {};

  const NUMBER_BLOCK = '((?:\\d{2} - ){5}\\d{2})';

  const modalityPatterns = [
    { key: 'tradicional',  pattern: new RegExp(`TRADICIONAL${NUMBER_BLOCK}`, 'i') },
    { key: 'segunda',      pattern: new RegExp(`LA SEGUNDA${NUMBER_BLOCK}`,  'i') },
    { key: 'revancha',     pattern: new RegExp(`REVANCHA${NUMBER_BLOCK}`,    'i') },
    { key: 'siempre_sale', pattern: new RegExp(`SIEMPRE SALE${NUMBER_BLOCK}`, 'i') },
  ];

  for (const { key, pattern } of modalityPatterns) {
    const m = bodyText.match(pattern);
    if (m) {
      const numbers = m[1].split(' - ').map(n => n.trim().padStart(2, '0'));
      modalities[key] = { numbers, prizes: [] };
      debug[`numbers_${key}`] = numbers;
    }
  }

  // ── Premios por modalidad ─────────────────────────────────────────────────
  // El sitio tiene una tabla con columnas: Aciertos | Ganadores | Premio
  // Parseamos las filas <tr> del DOM para cada modalidad.
  parsePrizesFromDOM($, modalities);

  // ── Validación ─────────────────────────────────────────────────────────────
  const warnings = [];
  if (!contestNumber)            warnings.push('No se encontró número de concurso');
  if (!drawDate)                 warnings.push('No se encontró fecha del sorteo');
  if (!modalities.tradicional)   warnings.push('No se encontraron números de Tradicional');
  if (warnings.length) {
    log.parser.warn({ warnings }, 'Parser warnings');
  }

  return {
    drawDate,
    drawDateRaw,
    contestNumber,
    jackpot,
    jackpotAmount,
    modalities,
    ...(warnings.length ? { _warnings: warnings } : {}),
    _debug: debug,
  };
}

// ── Premios desde el DOM ──────────────────────────────────────────────────────

/**
 * Busca la tabla de premios y asocia cada fila a su modalidad.
 * La tabla tiene encabezados de sección (TRADICIONAL, LA SEGUNDA, etc.)
 * seguidos de filas con Aciertos / Ganadores / Premio.
 */
function parsePrizesFromDOM($, modalities) {
  const SECTION_KEYS = {
    'TRADICIONAL':   'tradicional',
    'LA SEGUNDA':    'segunda',
    'REVANCHA':      'revancha',
    'SIEMPRE SALE':  'siempre_sale',
    'SIEMPRESALE':   'siempre_sale',
    'POZO EXTRA':    'pozo_extra',
  };

  let currentKey = null;

  $('tr').each((_, row) => {
    const cells     = $(row).find('td');
    const rowText   = $(row).text().replace(/\s+/g, ' ').trim().toUpperCase();

    // Detectar fila de encabezado de sección
    for (const [name, key] of Object.entries(SECTION_KEYS)) {
      if (rowText.includes(name) && cells.length <= 1) {
        currentKey = key;
        return;
      }
    }

    if (!currentKey) return;

    const texts = cells.map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
    if (texts.length < 2) return;

    // Verificar que la primera columna es un número de aciertos (4, 5 o 6)
    const hitsNum = parseInt(texts[0]);
    if (isNaN(hitsNum) || hitsNum < 1 || hitsNum > 6) return;

    const winners = texts[1]?.toLowerCase() === 'vacante' ? 0 : (parseInt(texts[1]) || 0);
    const prize   = texts[2] || '';

    const entry = {
      hits:           String(hitsNum),
      winners,
      prize,
      prizeAmount:    parseMoneyString(prize),
      prizePerWinner: texts[3] || '',
    };

    if (!modalities[currentKey]) {
      modalities[currentKey] = { numbers: [], prizes: [] };
    }
    if (!modalities[currentKey].prizes) {
      modalities[currentKey].prizes = [];
    }

    // Evitar duplicados por aciertos
    const alreadyExists = modalities[currentKey].prizes.some(p => p.hits === entry.hits);
    if (!alreadyExists) {
      modalities[currentKey].prizes.push(entry);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseMoneyString(str) {
  if (!str) return 0;
  // Elimina todo excepto dígitos (los puntos son separadores de miles en AR)
  const clean = str.replace(/[^\d]/g, '');
  return parseInt(clean) || 0;
}

// ── API pública ───────────────────────────────────────────────────────────────

async function fetchAndParseLatest() {
  log.parser.info('Obteniendo resultado desde quini-6-resultados...');
  try {
    const html = await fetchHTML();
    const parsed = parseQuiniHTML(html);
    if (parsed.contestNumber) {
      log.parser.info({ contestNumber: parsed.contestNumber, drawDate: parsed.drawDateRaw || parsed.drawDate }, 'Sorteo obtenido');
    }
    return parsed;
  } catch (err) {
    log.parser.error({ err: err.message }, 'Error al obtener');
    throw err;
  }
}

async function fetchDebugInfo() {
  const html   = await fetchHTML();
  const parsed = parseQuiniHTML(html);
  return { html, parsed };
}

module.exports = { fetchAndParseLatest, fetchDebugInfo, parseQuiniHTML };
