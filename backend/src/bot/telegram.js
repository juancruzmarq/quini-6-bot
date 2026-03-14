/**
 * Bot de Telegram para Quini 6
 *
 * Seguridad:
 *   - INVITE_CODE: código requerido para registrarse (/start CODIGO)
 *   - MAX_TICKETS_PER_USER: límite de tickets por usuario (default: 10)
 *   - Rate limiting: cooldown de 3s entre comandos del mismo tipo por usuario
 *   - ADMIN_TELEGRAM_ID: chatId del admin con acceso a comandos especiales
 *
 * Comandos usuarios:
 *   /start CODIGO       — Registrarse con el código de invitación
 *   /add 09,11,12,...   — Agregar ticket
 *   /tickets            — Ver mis tickets
 *   /delete 3           — Eliminar ticket N° 3
 *   /ultimo             — Ver el último sorteo guardado
 *   /sorteo 11/03/2026  — Ver sorteo por fecha o número
 *   /help               — Ayuda
 *
 * Comandos admin (solo ADMIN_TELEGRAM_ID):
 *   /runcycle           — Forzar ciclo completo (fetch + validar + notificar)
 *   /status             — Estado del sistema
 */

const TelegramBot = require('node-telegram-bot-api');
const db          = require('../db');
const { validateAndNormalizeNumbers } = require('../routes/tickets');
const { setBotInstance }              = require('../routes/notifications');

// ── Configuración ─────────────────────────────────────────────────────────────

const INVITE_CODE         = process.env.INVITE_CODE || null;
const MAX_TICKETS         = parseInt(process.env.MAX_TICKETS_PER_USER) || 10;
const ADMIN_CHAT_ID       = process.env.ADMIN_TELEGRAM_ID ? String(process.env.ADMIN_TELEGRAM_ID) : null;
const COMMAND_COOLDOWN_MS = 3000; // 3 segundos entre el mismo comando por usuario

function isAdmin(chatId) {
  return ADMIN_CHAT_ID && String(chatId) === ADMIN_CHAT_ID;
}

// ── Rate limiter en memoria ───────────────────────────────────────────────────
// { "chatId:comando": timestamp }
const lastCommandTime = new Map();

function isRateLimited(chatId, command) {
  const key  = `${chatId}:${command}`;
  const now  = Date.now();
  const last = lastCommandTime.get(key) || 0;
  if (now - last < COMMAND_COOLDOWN_MS) return true;
  lastCommandTime.set(key, now);
  return false;
}

// Limpiar entradas viejas cada 5 minutos para no acumular memoria
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, ts] of lastCommandTime.entries()) {
    if (ts < cutoff) lastCommandTime.delete(key);
  }
}, 5 * 60_000);

// ── Bot ───────────────────────────────────────────────────────────────────────

let bot          = null;
let _runFullCycle = null;

function setRunCycleHandler(fn) {
  _runFullCycle = fn;
}

function initializeBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!bot) {
    bot = new TelegramBot(token, { polling: true });
    registerHandlers(bot);
    setBotInstance(bot);
    console.log('🤖 Bot de Telegram iniciado en modo polling');
    if (INVITE_CODE) {
      console.log(`🔒 Código de invitación activo`);
    } else {
      console.warn('⚠️  INVITE_CODE no configurado — el bot es público');
    }
    console.log(`📊 Límite de tickets por usuario: ${MAX_TICKETS}`);
    if (ADMIN_CHAT_ID) {
      console.log(`🛡️  Admin configurado: chatId ${ADMIN_CHAT_ID}`);
    } else {
      console.warn('⚠️  ADMIN_TELEGRAM_ID no configurado — comandos admin deshabilitados');
    }
  }
  return bot;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function registerHandlers(bot) {

  // /start [CODIGO] — Registro con código de invitación
  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId   = String(msg.chat.id);
    const input    = (match[1] || '').trim();
    const name     = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
    const username = msg.from.username || null;

    if (isRateLimited(chatId, 'start')) return;

    try {
      // Si ya está registrado → saludo de regreso, sin pedir código
      const existing = await getUserByChatId(chatId);
      if (existing) {
        return bot.sendMessage(chatId, [
          `👋 *¡Hola de nuevo, ${existing.name || 'usuario'}!*`,
          ``,
          `Ya estás registrado. Tus comandos:`,
          `/add — Agregar ticket`,
          `/tickets — Ver tus tickets`,
          `/ultimo — Último sorteo`,
          `/help — Ayuda completa`,
        ].join('\n'), { parse_mode: 'Markdown' });
      }

      // Usuario nuevo → verificar código si está configurado
      if (INVITE_CODE) {
        if (!input) {
          return bot.sendMessage(chatId,
            `🔒 Este bot es privado.\n\nPara registrarte necesitás un código de invitación:\n/start TUCODIGO`
          );
        }
        if (input !== INVITE_CODE) {
          console.warn(`🚫 Intento de registro con código incorrecto — chatId: ${chatId}, username: @${username}`);
          return bot.sendMessage(chatId, `❌ Código de invitación inválido.`);
        }
      }

      // Registrar usuario nuevo
      const { rows } = await db.query(
        `INSERT INTO users (telegram_chat_id, name, telegram_username)
         VALUES ($1, $2, $3)
         ON CONFLICT (telegram_chat_id)
         DO UPDATE SET
           name              = COALESCE(EXCLUDED.name, users.name),
           telegram_username = COALESCE(EXCLUDED.telegram_username, users.telegram_username),
           updated_at        = NOW()
         RETURNING id, name`,
        [chatId, name || null, username]
      );

      const user = rows[0];
      console.log('[BOT] Nuevo usuario registrado:', { chatId, name: user.name, username: username || '-' });

      await bot.sendMessage(chatId, [
        `👋 *¡Bienvenido al sistema Quini 6, ${user.name || 'usuario'}!*`,
        ``,
        `Con este bot podés:`,
        `• Registrar tus tickets del Quini 6`,
        `• Recibir notificaciones automáticas si ganás`,
        `• Consultar resultados de cualquier sorteo`,
        ``,
        `*Comandos disponibles:*`,
        `/add 09,11,12,14,18,20 — Agregar un ticket`,
        `/tickets — Ver tus tickets`,
        `/delete 3 — Eliminar el ticket N° 3`,
        `/ultimo — Ver el último sorteo`,
        `/sorteo 11/03/2026 — Ver sorteo por fecha`,
        `/help — Ver ayuda completa`,
      ].join('\n'), { parse_mode: 'Markdown' });

    } catch (err) {
      console.error('[BOT] Error en /start (registro):', err.message);
      await bot.sendMessage(chatId, '❌ Error al registrar usuario. Intentá de nuevo más tarde.');
    }
  });

  // /add — Agregar ticket
  bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const input  = match[1].trim();

    if (isRateLimited(chatId, 'add')) return;

    try {
      const user = await getUserByChatId(chatId);
      if (!user) {
        return bot.sendMessage(chatId, '❌ No estás registrado. Usá /start para unirte.');
      }

      const result = validateAndNormalizeNumbers(input.split(/[\s,]+/));
      if (!result.valid) {
        return bot.sendMessage(chatId,
          `❌ *Números inválidos:* ${result.error}`, { parse_mode: 'Markdown' }
        );
      }

      // Verificar límite de tickets
      const countRes = await db.query(
        'SELECT COUNT(*) FROM tickets WHERE user_id = $1 AND is_active = true',
        [user.id]
      );
      const count = parseInt(countRes.rows[0].count);
      if (count >= MAX_TICKETS) {
        return bot.sendMessage(chatId,
          `⚠️ Límite alcanzado: podés tener hasta *${MAX_TICKETS} tickets* activos.\n\nUsá /delete para eliminar uno primero.`,
          { parse_mode: 'Markdown' }
        );
      }

      // Verificar duplicados
      const dup = await db.query(
        `SELECT id FROM tickets
         WHERE user_id = $1 AND is_active = true AND numbers_json = $2::jsonb`,
        [user.id, JSON.stringify(result.numbers)]
      );
      if (dup.rows.length > 0) {
        return bot.sendMessage(chatId, `⚠️ Ya tenés ese ticket registrado.`);
      }

      const { rows } = await db.query(
        `INSERT INTO tickets (user_id, numbers_json) VALUES ($1, $2) RETURNING id`,
        [user.id, JSON.stringify(result.numbers)]
      );

      await bot.sendMessage(chatId, [
        `✅ *Ticket agregado* (${count + 1}/${MAX_TICKETS})`,
        ``,
        `🎱 ${result.numbers.join(' - ')}`,
        ``,
        `Recibirás una notificación automática si este ticket gana.`,
      ].join('\n'), { parse_mode: 'Markdown' });

    } catch (err) {
      console.error('/add error:', err);
      await bot.sendMessage(chatId, '❌ Error al guardar el ticket. Intentá de nuevo.');
    }
  });

  // /tickets — Listar tickets
  bot.onText(/\/tickets/, async (msg) => {
    const chatId = String(msg.chat.id);

    if (isRateLimited(chatId, 'tickets')) return;

    try {
      const user = await getUserByChatId(chatId);
      if (!user) {
        return bot.sendMessage(chatId, '❌ No estás registrado. Usá /start para unirte.');
      }

      const { rows } = await db.query(
        `SELECT id, label, numbers_json, created_at
         FROM tickets
         WHERE user_id = $1 AND is_active = true
         ORDER BY created_at ASC`,
        [user.id]
      );

      if (!rows.length) {
        return bot.sendMessage(chatId, [
          `No tenés tickets registrados.`,
          ``,
          `Usá /add 09,11,12,14,18,20 para agregar uno.`,
        ].join('\n'));
      }

      const lines = rows.map((t, i) => {
        const nums  = t.numbers_json.join(' - ');
        const label = t.label ? ` _(${t.label})_` : '';
        return `*${i + 1}.* ${nums}${label}`;
      });

      await bot.sendMessage(chatId, [
        `🎱 *Tus tickets activos (${rows.length}/${MAX_TICKETS}):*`,
        ``,
        ...lines,
        ``,
        `Para eliminar un ticket usá /delete N° (ej: /delete 1)`,
      ].join('\n'), { parse_mode: 'Markdown' });

    } catch (err) {
      console.error('/tickets error:', err);
      await bot.sendMessage(chatId, '❌ Error al obtener tickets.');
    }
  });

  // /delete — Eliminar ticket por número de posición
  bot.onText(/\/delete (\d+)/, async (msg, match) => {
    const chatId   = String(msg.chat.id);
    const position = parseInt(match[1], 10);

    if (isRateLimited(chatId, 'delete')) return;

    try {
      const user = await getUserByChatId(chatId);
      if (!user) {
        return bot.sendMessage(chatId, '❌ No estás registrado. Usá /start para unirte.');
      }

      const { rows } = await db.query(
        `SELECT id, numbers_json FROM tickets
         WHERE user_id = $1 AND is_active = true
         ORDER BY created_at ASC`,
        [user.id]
      );

      if (position < 1 || position > rows.length) {
        return bot.sendMessage(
          chatId,
          `❌ Posición inválida. Tenés ${rows.length} ticket(s). Usá /tickets para ver la lista.`
        );
      }

      const ticket = rows[position - 1];
      await db.query(
        'UPDATE tickets SET is_active = false, updated_at = NOW() WHERE id = $1',
        [ticket.id]
      );

      await bot.sendMessage(chatId, [
        `✅ Ticket eliminado:`,
        `🎱 ${ticket.numbers_json.join(' - ')}`,
      ].join('\n'));

    } catch (err) {
      console.error('/delete error:', err);
      await bot.sendMessage(chatId, '❌ Error al eliminar el ticket.');
    }
  });

  // /ultimo — Último sorteo guardado
  bot.onText(/\/ultimo/, async (msg) => {
    const chatId = String(msg.chat.id);

    if (isRateLimited(chatId, 'ultimo')) return;

    try {
      const user = await getUserByChatId(chatId);
      if (!user) {
        return bot.sendMessage(chatId, '❌ No estás registrado. Usá /start para unirte.');
      }

      const { rows } = await db.query(
        'SELECT * FROM quini_results ORDER BY draw_date DESC LIMIT 1'
      );
      if (!rows.length) {
        return bot.sendMessage(chatId, '📭 No hay sorteos guardados todavía.');
      }
      await bot.sendMessage(chatId, formatDrawMessage(rows[0]), { parse_mode: 'Markdown' });

    } catch (err) {
      console.error('/ultimo error:', err);
      await bot.sendMessage(chatId, '❌ Error al obtener el último sorteo.');
    }
  });

  // /sorteo <fecha o número>
  bot.onText(/\/sorteo (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const input  = match[1].trim();

    if (isRateLimited(chatId, 'sorteo')) return;

    try {
      const user = await getUserByChatId(chatId);
      if (!user) {
        return bot.sendMessage(chatId, '❌ No estás registrado. Usá /start para unirte.');
      }

      let draw = null;

      if (/^\d{3,5}$/.test(input)) {
        const { rows } = await db.query(
          'SELECT * FROM quini_results WHERE contest_number = $1', [input]
        );
        draw = rows[0] || null;
      } else {
        const dateMatch = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (!dateMatch) {
          return bot.sendMessage(chatId,
            `❌ Formato inválido. Usá:\n/sorteo 11/03/2026  — por fecha\n/sorteo 3355  — por número`
          );
        }
        const [, day, month, year] = dateMatch;
        const { rows } = await db.query(
          'SELECT * FROM quini_results WHERE draw_date = $1',
          [`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`]
        );
        draw = rows[0] || null;
      }

      if (!draw) {
        return bot.sendMessage(chatId,
          `📭 No encontré ningún sorteo para *${input}*.`,
          { parse_mode: 'Markdown' }
        );
      }

      await bot.sendMessage(chatId, formatDrawMessage(draw), { parse_mode: 'Markdown' });

    } catch (err) {
      console.error('/sorteo error:', err);
      await bot.sendMessage(chatId, '❌ Error al buscar el sorteo.');
    }
  });

  // ── Comandos admin ───────────────────────────────────────────────────────────

  // /runcycle — Forzar el ciclo completo manualmente
  bot.onText(/\/runcycle/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!isAdmin(chatId)) return;
    if (isRateLimited(chatId, 'runcycle')) return;

    await bot.sendMessage(chatId, '🔄 Iniciando ciclo completo...');
    console.log('[BOT] Admin /runcycle ejecutado');
    try {
      if (!_runFullCycle) {
        return bot.sendMessage(chatId, '❌ Handler de ciclo no configurado.');
      }
      const result = await _runFullCycle();

      const lines = ['📋 *Resultado del ciclo:*', ''];

      if (result.error) {
        lines.push(`❌ Error: ${result.error}`);
      } else {
        const f = result.fetchResult;
        if (f?.alreadyExists) {
          lines.push(`📦 Sorteo ${f.contestNumber} ya estaba guardado`);
        } else if (f) {
          lines.push(`✅ Sorteo ${f.contestNumber} (${f.drawDate}) guardado`);
        }

        const v = result.validateResult;
        if (v) {
          lines.push(`🎯 ${v.totalTickets} tickets validados — ${v.winnersCount} ganadores`);
        }

        const n = result.notifyResult;
        if (n) {
          lines.push(`📨 ${n.notified ?? 0} notificaciones enviadas`);
        }
      }

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('[BOT] Error en /runcycle:', err.message);
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });

  // /status — Estado del sistema (admin)
  bot.onText(/\/status/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!isAdmin(chatId)) return;
    if (isRateLimited(chatId, 'status')) return;

    try {
      const [usersRes, ticketsRes, lastDrawRes, lastContestRes] = await Promise.all([
        db.query('SELECT COUNT(*)::int AS count FROM users WHERE is_active = true'),
        db.query('SELECT COUNT(*)::int AS count FROM tickets WHERE is_active = true'),
        db.query('SELECT contest_number, draw_date FROM quini_results ORDER BY draw_date DESC LIMIT 1'),
        db.query('SELECT contest_number FROM ticket_results ORDER BY created_at DESC LIMIT 1'),
      ]);

      const lastDraw = lastDrawRes.rows[0];
      let lastVal = null;
      if (lastContestRes.rows[0]) {
        const cn = lastContestRes.rows[0].contest_number;
        const agg = await db.query(
          'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE won_any_prize)::int AS winners FROM ticket_results WHERE contest_number = $1',
          [cn]
        );
        lastVal = { contest_number: cn, ...agg.rows[0] };
      }

      const lines = [
        `🛡️ *Estado del sistema Quini 6*`,
        ``,
        `👥 Usuarios activos: ${usersRes.rows[0].count}`,
        `🎱 Tickets activos:  ${ticketsRes.rows[0].count}`,
        ``,
        `📅 Último sorteo guardado:`,
        lastDraw
          ? `   N° ${lastDraw.contest_number} — ${String(lastDraw.draw_date).slice(0,10)}`
          : `   (ninguno)`,
        ``,
        `📊 Última validación:`,
        lastVal
          ? `   Sorteo ${lastVal.contest_number} — ${lastVal.winners} ganadores de ${lastVal.total} tickets`
          : `   (ninguna)`,
        ``,
        `⏰ Próxima ejecución: mié/dom a las 21:15 hs`,
      ];

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });

  // /resultado o /check — ¿Cómo me fue en el último sorteo?
  bot.onText(/\/(resultado|check)/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (isRateLimited(chatId, 'resultado')) return;

    try {
      const user = await getUserByChatId(chatId);
      if (!user) {
        return bot.sendMessage(chatId, '❌ No estás registrado. Usá /start para unirte.');
      }

      const lastDraw = (await db.query('SELECT * FROM quini_results ORDER BY draw_date DESC LIMIT 1')).rows[0];
      if (!lastDraw) {
        return bot.sendMessage(chatId, '📭 Aún no hay sorteos guardados.');
      }

      const myTickets = (await db.query(
        'SELECT id, numbers_json, label FROM tickets WHERE user_id = $1 AND is_active = true ORDER BY created_at ASC',
        [user.id]
      )).rows;

      if (!myTickets.length) {
        return bot.sendMessage(chatId, 'No tenés tickets registrados. Usá /add para agregar.');
      }

      const results = await db.query(
        `SELECT tr.ticket_id, tr.won_any_prize, tr.results_json
         FROM ticket_results tr
         JOIN tickets t ON t.id = tr.ticket_id
         WHERE tr.contest_number = $1 AND t.user_id = $2`,
        [lastDraw.contest_number, user.id]
      );

      const byTicket = new Map(results.rows.map(r => [r.ticket_id, r]));

      const MOD_NAMES = { tradicional: 'Tradicional', segunda: 'La Segunda', revancha: 'Revancha', siempre_sale: 'Siempre Sale', pozo_extra: 'Pozo Extra' };
      const lines = [
        `📋 *¿Cómo me fue? — Sorteo N° ${lastDraw.contest_number}*`,
        `📅 ${lastDraw.result_json?.drawDateRaw || lastDraw.draw_date}`,
        ``,
      ];

      myTickets.forEach((t, i) => {
        const tr = byTicket.get(t.id);
        const nums = t.numbers_json.join(' - ');
        const label = t.label ? ` _(${t.label})_` : '';
        if (!tr) {
          lines.push(`🎱 *${i + 1}.* ${nums}${label}`);
          lines.push(`   ⏳ Sin validar para este sorteo`);
        } else if (tr.won_any_prize) {
          const wonMods = Object.entries(tr.results_json || {}).filter(([, r]) => r.won).map(([k]) => MOD_NAMES[k] || k);
          lines.push(`🎱 *${i + 1}.* ${nums}${label}`);
          lines.push(`   🏆 *Ganaste* en: ${wonMods.join(', ')}`);
        } else {
          lines.push(`🎱 *${i + 1}.* ${nums}${label}`);
          lines.push(`   ▫️ Sin premio en este sorteo`);
        }
        lines.push('');
      });

      await bot.sendMessage(chatId, lines.join('\n').trim(), { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('/resultado error:', err);
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });

  // /historial — Últimos sorteos guardados
  bot.onText(/\/historial/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (isRateLimited(chatId, 'historial')) return;

    try {
      const user = await getUserByChatId(chatId);
      if (!user) {
        return bot.sendMessage(chatId, '❌ No estás registrado. Usá /start para unirte.');
      }

      const rows = (await db.query(
        'SELECT contest_number, draw_date FROM quini_results ORDER BY draw_date DESC LIMIT 10'
      )).rows;

      if (!rows.length) {
        return bot.sendMessage(chatId, '📭 No hay sorteos guardados todavía.');
      }

      const lines = [
        `📜 *Últimos sorteos guardados*`,
        ``,
        ...rows.map((r, i) => `  ${i + 1}. N° ${r.contest_number} — ${String(r.draw_date).slice(0, 10)}`),
        ``,
        `Consultá uno con /sorteo 3355 o /sorteo 11/03/2026`,
      ];

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('/historial error:', err);
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });

  // /recordar — Activar/desactivar recordatorio antes del sorteo
  bot.onText(/\/recordar/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (isRateLimited(chatId, 'recordar')) {
      return bot.sendMessage(chatId, '⏳ Esperá unos segundos y probá de nuevo.');
    }

    try {
      const user = await getUserByChatId(chatId);
      if (!user) {
        return bot.sendMessage(chatId, '❌ No estás registrado. Usá /start para unirte.');
      }

      await ensureReminderColumn();
      const current = user.reminder_enabled !== false;
      const next   = !current;

      try {
        await db.query(
          'UPDATE users SET reminder_enabled = $1, updated_at = NOW() WHERE id = $2',
          [next, user.id]
        );
      } catch (updateErr) {
        if (updateErr.code === '42703') {
          await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reminder_enabled BOOLEAN DEFAULT TRUE');
          await db.query(
            'UPDATE users SET reminder_enabled = $1, updated_at = NOW() WHERE id = $2',
            [next, user.id]
          );
        } else throw updateErr;
      }

      if (next) {
        await bot.sendMessage(chatId, '✅ Recordatorio *activado*. Te avisaré el martes y sábado antes del sorteo.');
      } else {
        await bot.sendMessage(chatId, '🔕 Recordatorio *desactivado*. No recibirás avisos previos al sorteo.');
      }
    } catch (err) {
      console.error('/recordar error:', err);
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });

  // /broadcast — Enviar mensaje a todos (solo admin)
  bot.onText(/\/broadcast\s*([\s\S]*)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    if (!isAdmin(chatId)) return;
    if (isRateLimited(chatId, 'broadcast')) return;

    const text = (match[1] || '').trim();
    if (!text) return bot.sendMessage(chatId, 'Escribí el mensaje: /broadcast Tu mensaje aquí');

    try {
      const { rows } = await db.query('SELECT telegram_chat_id FROM users WHERE is_active = true');
      let sent = 0;
      let failed = 0;
      for (const u of rows) {
        try {
          await bot.sendMessage(u.telegram_chat_id, `📢 *Aviso:*\n\n${text}`, { parse_mode: 'Markdown' });
          sent++;
        } catch (err) {
          failed++;
          console.error('[BOT] Broadcast fallido para chatId', u.telegram_chat_id, err.message);
        }
      }
      console.log('[BOT] Broadcast enviado:', sent, 'ok,', failed, 'fallidos');
      await bot.sendMessage(chatId, `📤 Broadcast enviado: ${sent} ok, ${failed} fallidos.`);
    } catch (err) {
      console.error('[BOT] Error en /broadcast:', err.message);
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });

  // /help
  bot.onText(/\/help/, async (msg) => {
    const chatId = String(msg.chat.id);

    if (isRateLimited(chatId, 'help')) return;

    await bot.sendMessage(chatId, [
      `*🎲 Quini 6 — Ayuda*`,
      ``,
      `*Registrarse:*`,
      `/start CODIGO`,
      ``,
      `*Agregar ticket:*`,
      `/add 09,11,12,14,18,20`,
      `Límite: ${MAX_TICKETS} tickets. Números del 0 al 45.`,
      ``,
      `*Ver tus tickets:*`,
      `/tickets`,
      ``,
      `*Eliminar un ticket:*`,
      `/delete 2`,
      ``,
      `*¿Cómo me fue en el último sorteo?*`,
      `/resultado` + ' o ' + '/check',
      ``,
      `*Último sorteo guardado:*`,
      `/ultimo`,
      ``,
      `*Historial de sorteos:*`,
      `/historial`,
      ``,
      `*Buscar un sorteo:*`,
      `/sorteo 11/03/2026` + ' o ' + '/sorteo 3355',
      ``,
      `*Recordatorio:*`,
      `/recordar` + ' — activar/desactivar aviso antes del sorteo',
      ``,
      `*Notificaciones:*`,
      `Cuando haya resultados (mié/dom), recibirás un mensaje. Si ganaste, con el detalle.`,
      `Sorteos: miércoles y domingos 21:15 hs.`,
    ].join('\n'), { parse_mode: 'Markdown' });
  });

  // Mensajes sin comando reconocido
  bot.on('message', async (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
      const chatId = String(msg.chat.id);
      if (isRateLimited(chatId, 'unknown')) return;
      await bot.sendMessage(chatId,
        `No entiendo ese mensaje. Usá /help para ver los comandos disponibles.`
      );
    }
  });

  bot.on('polling_error', (err) => {
    if (err.message && err.message.includes('401')) {
      console.error('❌ Token de Telegram inválido (401) — deteniendo polling.');
      bot.stopPolling();
      return;
    }
    console.error('Telegram polling error:', err.message);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getUserByChatId(chatId) {
  const { rows } = await db.query(
    'SELECT * FROM users WHERE telegram_chat_id = $1 AND is_active = true',
    [String(chatId)]
  );
  return rows[0] || null;
}

let _reminderColumnChecked = false;
async function ensureReminderColumn() {
  if (_reminderColumnChecked) return;
  try {
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reminder_enabled BOOLEAN DEFAULT TRUE');
    _reminderColumnChecked = true;
  } catch (err) {
    if (err.code !== '42701') throw err; // 42701 = column already exists
    _reminderColumnChecked = true;
  }
}

// ── Formateo de sorteo ────────────────────────────────────────────────────────

const MODALITY_LABELS = {
  tradicional:  '🔵 TRADICIONAL',
  segunda:      '🟢 LA SEGUNDA',
  revancha:     '🔴 REVANCHA',
  siempre_sale: '🟡 SIEMPRE SALE',
  pozo_extra:   '⭐ POZO EXTRA',
};

function formatDrawMessage(drawRow) {
  const r     = drawRow.result_json;
  const date  = r.drawDateRaw || drawRow.draw_date;
  const lines = [
    `⭕ *Quini 6 — Sorteo N° ${drawRow.contest_number}*`,
    `📅 Fecha: ${date}`,
    r.jackpot ? `💰 Pozo acumulado: *${r.jackpot}*` : '',
    ``,
  ].filter(Boolean);

  const ORDER = ['tradicional', 'segunda', 'revancha', 'siempre_sale', 'pozo_extra'];

  for (const key of ORDER) {
    const mod = r.modalities?.[key];
    if (!mod) continue;

    const label   = MODALITY_LABELS[key] || key.toUpperCase();
    const numbers = mod.numbers?.length ? mod.numbers.join(' - ') : '—';

    lines.push(`*${label}*`);
    lines.push(`🎱 ${numbers}`);

    if (mod.prizes?.length) {
      for (const p of mod.prizes) {
        const ganadores = p.winners === 0 ? 'Vacante' : `${p.winners} ganador${p.winners !== 1 ? 'es' : ''}`;
        lines.push(`  ${p.hits} aciertos → ${ganadores} | ${p.prize}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

module.exports = { initializeBot, setRunCycleHandler };
