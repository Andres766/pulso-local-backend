-- Versión de sesión: sube al cambiar la contraseña y deja sin efecto todos los JWT emitidos antes.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0);
