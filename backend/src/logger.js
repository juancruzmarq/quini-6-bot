/**
 * Logger centralizado con Pino.
 * Producción: JSON a stdout (Railway, agregadores).
 * Desarrollo: salida legible con pino-pretty.
 *
 * Uso:
 *   const log = require('./logger');
 *   log.info('mensaje');
 *   log.http.info({ method: 'GET', url: '/api', status: 200, ms: 12 }, 'request');
 *   log.db.error({ err }, 'Pool error');
 */

const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';
const level = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');

const baseOptions = {
  level,
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
};

// En desarrollo: salida legible con pino-pretty
const opts = isDev
  ? {
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    }
  : baseOptions;

const base = pino(opts);

function child(name) {
  return base.child({ module: name });
}

const log = Object.assign(base, {
  http: child('http'),
  db: child('db'),
  parser: child('parser'),
  cron: child('cron'),
  api: child('api'),
  bot: child('bot'),
  app: child('app'),
});

module.exports = log;
