CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  VARCHAR(255) UNIQUE NOT NULL,
  password_hash          VARCHAR(255) NOT NULL,
  role                   VARCHAR(10)  NOT NULL DEFAULT 'user',
  status                 VARCHAR(20)  NOT NULL DEFAULT 'pending',
  must_change_password   BOOLEAN      NOT NULL DEFAULT true,
  provisional_expires_at TIMESTAMPTZ,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(128) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS airlines (
  code   VARCHAR(10)  PRIMARY KEY,
  name   VARCHAR(100) NOT NULL,
  active BOOLEAN      NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS routines (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                   VARCHAR(100)  NOT NULL,
  airline                VARCHAR(10)   NOT NULL REFERENCES airlines(code),
  origin                 CHAR(3)       NOT NULL,
  destination            CHAR(3)       NOT NULL,
  outbound_start         DATE          NOT NULL,
  outbound_end           DATE          NOT NULL,
  return_start           DATE,
  return_end             DATE,
  passengers             SMALLINT      NOT NULL DEFAULT 1,
  target_brl             NUMERIC(10,2),
  target_pts             INTEGER,
  target_hyb_pts         INTEGER,
  target_hyb_brl         NUMERIC(10,2),
  margin                 NUMERIC(4,3)  NOT NULL DEFAULT 0.1,
  priority               VARCHAR(3)    NOT NULL DEFAULT 'brl',
  notification_mode      VARCHAR(30)   NOT NULL,
  notification_frequency VARCHAR(10)   NOT NULL,
  end_of_period_time     TIME,
  cc_emails              JSONB         NOT NULL DEFAULT '[]',
  pending_request_id     UUID,
  pending_request_at     TIMESTAMPTZ,
  is_active              BOOLEAN       NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flight_offers (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id            UUID         NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  airline               VARCHAR(10)  NOT NULL,
  flight_number         VARCHAR(10)  NOT NULL,
  date                  DATE         NOT NULL,
  is_return             BOOLEAN      NOT NULL DEFAULT false,
  origin_iata           CHAR(3)      NOT NULL,
  origin_timestamp      TIMESTAMPTZ  NOT NULL,
  destination_iata      CHAR(3)      NOT NULL,
  destination_timestamp TIMESTAMPTZ  NOT NULL,
  duration_min          INTEGER      NOT NULL,
  stops                 SMALLINT     NOT NULL DEFAULT 0,
  fare_brl              NUMERIC(10,2),
  fare_pts              INTEGER,
  fare_hyb_pts          INTEGER,
  fare_hyb_brl          NUMERIC(10,2),
  within_target         BOOLEAN      NOT NULL DEFAULT false,
  scraped_at            TIMESTAMPTZ  NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS best_fares (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id      UUID           NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  date            DATE           NOT NULL,
  is_return       BOOLEAN        NOT NULL DEFAULT false,
  fare_type       VARCHAR(3)     NOT NULL,
  amount          NUMERIC(12,2)  NOT NULL,
  flight_offer_id UUID           NOT NULL REFERENCES flight_offers(id) ON DELETE CASCADE,
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  UNIQUE(routine_id, date, is_return, fare_type)
);

CREATE TABLE IF NOT EXISTS notification_log (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id      UUID           NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  type            VARCHAR(20)    NOT NULL,
  fare_type       VARCHAR(3)     NOT NULL,
  outbound_amount NUMERIC(12,2),
  return_amount   NUMERIC(12,2),
  email_to        VARCHAR(255)   NOT NULL,
  email_cc        TEXT,
  sent_at         TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  token      VARCHAR(128) UNIQUE NOT NULL,
  routine_id UUID         NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  email      VARCHAR(255) NOT NULL,
  is_primary BOOLEAN      NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ  NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routines_user        ON routines(user_id);
CREATE INDEX IF NOT EXISTS idx_routines_dispatch    ON routines(is_active, pending_request_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_offers_routine_date  ON flight_offers(routine_id, scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_best_fares_routine   ON best_fares(routine_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_routine    ON notification_log(routine_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_unsub_token          ON unsubscribe_tokens(token);
CREATE INDEX IF NOT EXISTS idx_reset_token          ON password_reset_tokens(token);
