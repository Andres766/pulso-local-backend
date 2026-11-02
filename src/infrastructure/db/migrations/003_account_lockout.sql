-- Bloqueo temporal por cuenta tras varios inicios de sesión fallidos seguidos (ver User.registerFailedLogin).
ALTER TABLE users
  ADD COLUMN failed_logins SMALLINT NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  ADD COLUMN locked_until  TIMESTAMPTZ;
