const express = require('express');
const cors    = require('cors');
const db      = require('./db');

const resultsRouter       = require('./routes/results');
const ticketsRouter       = require('./routes/tickets');
const usersRouter         = require('./routes/users');
const notificationsRouter = require('./routes/notifications');
const { initializeCron, runFullCycle, setBotForCron, setAdminChatId } = require('./services/cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
    const result = await runFullCycle();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Error handler global
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// Migración: columna recordatorio (bases existentes)
db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reminder_enabled BOOLEAN DEFAULT TRUE').catch(() => {});

app.listen(PORT, () => {
  console.log(`🚀 Quini Backend corriendo en puerto ${PORT}`);
});

// ── Telegram Bot ──────────────────────────────────────────────────────────────
const botToken           = process.env.TELEGRAM_BOT_TOKEN || '';
const tokenParecePvalido = botToken.length > 20 && botToken.includes(':');

if (tokenParecePvalido) {
  try {
    const { initializeBot, setRunCycleHandler } = require('./bot/telegram');
    const bot = initializeBot();
    setBotForCron(bot);
    setAdminChatId(process.env.ADMIN_TELEGRAM_ID);
    setRunCycleHandler(runFullCycle);
    console.log('🤖 Bot de Telegram iniciado');
  } catch (err) {
    console.error('Error iniciando bot de Telegram:', err.message);
  }
} else {
  console.warn('⚠️  TELEGRAM_BOT_TOKEN no configurado — bot deshabilitado');
}

// ── Cron scheduler ────────────────────────────────────────────────────────────
initializeCron();

module.exports = app;
