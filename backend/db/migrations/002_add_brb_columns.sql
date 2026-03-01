-- ============================================================================
--  Migration 002  –  Anti-Scuff / BRB Layer
--  SIL IRL Hosting Platform
--
--  Adds BRB (Be Right Back) settings to the users table.
--
--  Feature: when a streamer's 4G/5G signal drops mid-stream, instead of
--  immediately disconnecting YouTube/Kick/Twitch (which causes a stream error
--  and loses viewers), SIL:
--
--    1. Waits a configurable grace period (default 10 s, env BRB_GRACE_MS)
--    2. If no reconnect in that window, spawns an FFmpeg process that loops
--       a "Be Right Back" video/image to all platforms simultaneously
--    3. If the streamer reconnects within brb_timeout_seconds, the BRB loop
--       is killed and live restreaming resumes seamlessly
--    4. If timeout is exceeded, the stream is cleanly ended in the DB
--
--  New columns:
--    brb_enabled          – master toggle; if false, stream ends immediately
--                           on signal drop (no BRB loop started)
--
--    brb_timeout_seconds  – how many seconds to keep the BRB loop running
--                           before giving up. Range 30–1800. Default 300 (5 min).
--
--    brb_media_path       – relative path to a user-uploaded BRB video/image.
--                           Stored under uploads/brb/<username>.<ext>.
--                           NULL → SIL generates a "Be Right Back" screen
--                           using FFmpeg lavfi (no upload required).
-- ============================================================================

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS brb_enabled         BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS brb_timeout_seconds INTEGER NOT NULL DEFAULT 300
        CHECK (brb_timeout_seconds BETWEEN 30 AND 1800),
    ADD COLUMN IF NOT EXISTS brb_media_path      TEXT;

-- Comment existing rows (back-fill is not needed; defaults are correct)
COMMENT ON COLUMN users.brb_enabled         IS 'Keep platforms live via BRB loop during signal drops';
COMMENT ON COLUMN users.brb_timeout_seconds IS 'Max seconds to hold BRB before ending stream (30-1800)';
COMMENT ON COLUMN users.brb_media_path      IS 'Relative path to uploaded BRB media: brb/<username>.mp4';
