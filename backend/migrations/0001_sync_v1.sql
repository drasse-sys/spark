-- SYNC1 multi-device sync relay, schema V1. Only the isolated `sync-lab` environment binds a database (see wrangler.toml).
-- The Worker stores ciphertext and the minimum metadata needed to authorize, order and bound it. It holds no key that
-- can decrypt a payload. Every row is scoped by family_id, derived on the Worker from its own secret, never from input.

CREATE TABLE IF NOT EXISTS sync_families (
  family_id    TEXT PRIMARY KEY,
  gen          TEXT NOT NULL,              -- random generation id, replaced on reset
  verifier     TEXT NOT NULL,              -- SHA-256 of the membership proof (an HKDF output of the family key)
  head         INTEGER NOT NULL DEFAULT 0, -- last assigned sequence number; never decreases
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_devices (
  family_id   TEXT NOT NULL,
  device_id   TEXT NOT NULL,               -- the id inside the Worker-signed device token
  status      TEXT NOT NULL CHECK (status IN ('active','revoked')),
  enrolled_at INTEGER NOT NULL,
  seen_day    INTEGER NOT NULL,            -- last activity, day resolution only
  PRIMARY KEY (family_id, device_id)
);

CREATE TABLE IF NOT EXISTS sync_children (
  family_id  TEXT NOT NULL,
  child_id   TEXT NOT NULL,                -- random 128-bit id chosen by the sharing phone
  status     TEXT NOT NULL CHECK (status IN ('active','deleted')),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (family_id, child_id)
);

CREATE TABLE IF NOT EXISTS sync_records (
  family_id   TEXT NOT NULL,
  seq         INTEGER NOT NULL,            -- per-family order, assigned at insert
  record_id   TEXT NOT NULL,               -- random 128-bit id chosen by the phone: the idempotency key
  child_id    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('base','op','tombstone')),
  received_at INTEGER NOT NULL,            -- Worker clock
  clock_ok    INTEGER NOT NULL CHECK (clock_ok IN (0,1)),
  iv          TEXT NOT NULL,
  ct          TEXT NOT NULL,               -- AES-256-GCM ciphertext, base64url
  PRIMARY KEY (family_id, seq),
  UNIQUE (family_id, record_id)
);

CREATE INDEX IF NOT EXISTS sync_records_child ON sync_records (family_id, child_id);

-- Tombstones outlive a reset: a phone that re-joins after a reset verifies them with its previous key and generation,
-- so a child deleted before the reset cannot come back from that phone. One row per deleted child.
CREATE TABLE IF NOT EXISTS sync_tombstones (
  family_id  TEXT NOT NULL,
  child_id   TEXT NOT NULL,
  gen        TEXT NOT NULL,                -- generation the tombstone was encrypted for
  record_id  TEXT NOT NULL,
  iv         TEXT NOT NULL,
  ct         TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, child_id)
);
