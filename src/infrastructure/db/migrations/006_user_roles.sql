-- Control de acceso por roles: "user" (dueño de negocios) o "admin" (operador de la plataforma).
-- El rol de administrador solo se asigna desde el servidor (npm run make-admin o ADMIN_EMAILS).
ALTER TABLE users
  ADD COLUMN role VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));
