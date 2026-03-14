-- ============================================
-- Quini 6 - Schema de base de datos
-- ============================================

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255),
  telegram_chat_id VARCHAR(50) UNIQUE NOT NULL,
  telegram_username VARCHAR(100),
  is_active       BOOLEAN DEFAULT TRUE,
  reminder_enabled BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tickets (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        VARCHAR(100),
  numbers_json JSONB NOT NULL,
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quini_results (
  id             SERIAL PRIMARY KEY,
  contest_number VARCHAR(20) UNIQUE NOT NULL,
  draw_date      DATE NOT NULL,
  result_json    JSONB NOT NULL,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_results (
  id             SERIAL PRIMARY KEY,
  ticket_id      INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  contest_number VARCHAR(20) NOT NULL,
  draw_date      DATE NOT NULL,
  won_any_prize  BOOLEAN DEFAULT FALSE,
  results_json   JSONB NOT NULL,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (ticket_id, contest_number)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_tickets_user_id    ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_is_active  ON tickets(is_active);
CREATE INDEX IF NOT EXISTS idx_results_contest    ON quini_results(contest_number);
CREATE INDEX IF NOT EXISTS idx_results_draw_date  ON quini_results(draw_date);
CREATE INDEX IF NOT EXISTS idx_tr_contest         ON ticket_results(contest_number);
CREATE INDEX IF NOT EXISTS idx_tr_won             ON ticket_results(won_any_prize);
CREATE INDEX IF NOT EXISTS idx_tr_ticket_id       ON ticket_results(ticket_id);
