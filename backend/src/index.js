const express = require('express');
const cors    = require('cors');
const db      = require('./db');
const log     = require('./logger');

const resultsRouter       = require('./routes/results');
const ticketsRouter       = require('./routes/tickets');
const usersRouter         = require('./routes/users');
const notificationsRouter = require('./routes/notifications');
const { initializeCron, runFullCycle, setBotForCron, setAdminChatId } = require('./services/cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Log de requests (método, ruta, status, duración)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const payload = { method: req.method, url: req.originalUrl || req.url, status, ms };
    if (status >= 500) log.http.error(payload, 'request');
    else log.http.info(payload, 'request');
  });
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/results',       resultsRouter);
app.use('/api/tickets',       ticketsRouter);
app.use('/api/users',         usersRouter);
app.use('/api/notifications', notificationsRouter);

// Ejecutar el ciclo completo manualmente (útil para pruebas o forzar un sorteo)
app.post('/api/run-cycle', async (_req, res, next) => {
  try {
    log.api.info('run-cycle solicitado manualmente');
    const result = await runFullCycle();
    if (result.error) {
      log.api.error({ error: result.error }, 'run-cycle finalizó con error');
    } else {
      log.api.info({
        fetch: result.fetchResult?.contestNumber ?? result.fetchResult?.alreadyExists,
        tickets: result.validateResult?.totalTickets,
        winners: result.validateResult?.winnersCount,
        notified: result.notifyResult?.notified,
      }, 'run-cycle OK');
    }
    res.json(result);
  } catch (err) {
    log.api.error({ err: err.message }, 'run-cycle excepción');
    next(err);
  }
});

// Error handler global
app.use((err, _req, res, _next) => {
  log.app.error({ err: err.message, stack: err.stack?.split('\n')[1]?.trim() }, 'Unhandled error');
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// Migración: columna recordatorio (bases existentes)
db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reminder_enabled BOOLEAN DEFAULT TRUE').catch(() => {});

async function start() {
  await db.runSchemaIfNeeded();

  const botToken           = process.env.TELEGRAM_BOT_TOKEN || '';
  const tokenParecePvalido = botToken.length > 20 && botToken.includes(':');

  if (tokenParecePvalido) {
    try {
      const { initializeBot, setRunCycleHandler } = require('./bot/telegram');
      const bot = initializeBot(app);
      setBotForCron(bot);
      setAdminChatId(process.env.ADMIN_TELEGRAM_ID);
      setRunCycleHandler(runFullCycle);
      log.info('Bot de Telegram iniciado');
    } catch (err) {
      log.error({ err: err.message }, 'Error iniciando bot de Telegram');
    }
  } else {
    log.warn('TELEGRAM_BOT_TOKEN no configurado — bot deshabilitado');
  }

  initializeCron();

  app.listen(PORT, () => {
    log.info({ port: PORT }, 'Quini Backend corriendo');
  });
}

start().catch((err) => {
  log.error({ err: err.message }, 'Error al iniciar');
  process.exit(1);
});

module.exports = app;
