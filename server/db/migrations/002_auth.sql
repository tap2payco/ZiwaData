-- Sign-in by phone number plus a one-time code sent over SMS, and roles the SERVER enforces.
--
-- NOTHING IN HERE IS A SECRET IN PLAIN TEXT.
-- The one-time code and the session token are stored only as SHA-256 hashes, salted with AUTH_SECRET.
-- A dump of this database does not let anyone sign in as somebody else.

-- ---------------------------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------------------------
-- A user is created on the first successful sign-in. The phone number IS the identity: there is no
-- password to lose. Roles are assigned by AUTH_ROLES at first sign-in, or changed with SQL later;
-- a user can never choose or change their own role, so the browser cannot promote itself.
CREATE TABLE users (
  id          text        PRIMARY KEY,
  -- Normalised to 255XXXXXXXXX. Unique, so one number is one account.
  phone       text        NOT NULL UNIQUE,
  role        text        NOT NULL DEFAULT 'farmer' CHECK (role IN ('farmer','lender','extension')),
  created_at  timestamptz NOT NULL,
  last_seen_at timestamptz,
  -- Tanzania Personal Data Protection Act 2022: when this person agreed, and to which version.
  -- NULL means they have not consented yet. Consent is a separate screen, still to build.
  consent_at      timestamptz,
  consent_version text,
  -- Set to stop a number signing in without deleting the record it is attached to.
  disabled    boolean     NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------------------------------
-- One-time codes
-- ---------------------------------------------------------------------------------------------
-- Short-lived, single-use, hashed. A row is kept after use so a replay can be refused and so the
-- rate limiter can still see it.
CREATE TABLE auth_codes (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone        text        NOT NULL,
  -- SHA-256(AUTH_SECRET + phone + code). Never the code itself.
  code_hash    text        NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  -- Wrong guesses. The code dies once this reaches the server's limit.
  attempts     integer     NOT NULL DEFAULT 0,
  -- Set the moment it is accepted, so the same code can never be used twice.
  consumed_at  timestamptz
);
CREATE INDEX auth_codes_phone_idx ON auth_codes (phone, created_at DESC);
-- At most one code alive per number: requesting a new one retires the old.
CREATE UNIQUE INDEX auth_codes_one_live_per_phone ON auth_codes (phone) WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------------------------
-- The browser holds a random token in an httpOnly cookie; the server holds only its hash.
CREATE TABLE sessions (
  -- SHA-256(AUTH_SECRET + token). The token itself exists only in the user's cookie.
  token_hash  text        PRIMARY KEY,
  user_id     text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------------------------
-- Settings become per user
-- ---------------------------------------------------------------------------------------------
-- The demo's single settings row stays for the no-sign-in mode. With sign-in on, each user has their
-- own row, so one farmer's phone number and language are never shown to another.
CREATE TABLE user_settings (
  user_id   text    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone     text,
  sms_lang  text    NOT NULL DEFAULT 'sw' CHECK (sms_lang IN ('sw','en'))
);

-- ---------------------------------------------------------------------------------------------
-- The SMS log gains a fourth kind
-- ---------------------------------------------------------------------------------------------
-- One-time codes are SMS too: they cost money and belong in the log and under the hourly cap.
-- As always the log records only the state, never the number and never the code.
ALTER TABLE sms_log DROP CONSTRAINT sms_log_kind_check;
ALTER TABLE sms_log ADD CONSTRAINT sms_log_kind_check CHECK (kind IN ('test','alert','inbound_reply','auth'));
