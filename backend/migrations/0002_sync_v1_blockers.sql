-- SYNC1 blocker burndown (B4): the device registry survives a family reset.
-- `gen` is the family generation this device last proved the key for. A device is a MEMBER only while status = 'active'
-- AND gen equals the family's current generation. A reset no longer deletes rows: every earlier device becomes
-- "inactive" (it must prove the NEW key to be a member again) and stays listable and revocable. 'revoked' rows are never
-- reactivated by a reset or a join. The registry is bounded in sync.js (see SYNC_LIMITS.devices*).
-- Nothing has been deployed: this file is the first migration that adds the column, applied after 0001.
ALTER TABLE sync_devices ADD COLUMN gen TEXT NOT NULL DEFAULT '';
