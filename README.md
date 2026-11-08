# PulsoLocal · Backend

**Dashboard de insights automáticos para negocios pequeños.** El dueño carga las reseñas de sus clientes y
PulsoLocal usa IA para detectar temas recurrentes, medir el sentimiento y generar recomendaciones concretas,
respaldadas con cifras reales.

> Proyecto final · Programación Orientada a la Web · Ingeniería de Software · UCC Pasto

- Arquitectura, patrones, modelo de datos y seguridad: **[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)**
- Exactitud medida de la IA: **[docs/EVALUACION.md](docs/EVALUACION.md)**
- Contrato de la API: `GET /api/openapi.json` (OpenAPI 3.1)
- En línea: https://pulso-local-frontend.vercel.app · API: https://pulso-local-backend.onrender.com/api/health

**Usuario demo:** `demo@pulsolocal.co` / `Galeras2026Pasto` (cinco negocios de Pasto: Café Galeras, Restaurante El Fogón, Peluquería Lunaria, Artesanías
Mopa-Mopa y Taller Mecánico Chapal, con reseñas de junio a noviembre de 2026)

## Requisitos
- Node.js 22 o superior
- Docker Desktop (para PostgreSQL)

## Desarrollo

```bash
# 1. Variables de entorno (desde la carpeta que contiene backend/ y frontend/)
cp .env.example .env            # completar JWT_SECRET y, opcionalmente, GEMINI_API_KEY
cp .env backend/.env

# 2. Base de datos (PostgreSQL 17 en el puerto 5434)
docker compose up -d db

# 3. API (http://localhost:4000): aplica las migraciones al arrancar
cd backend
npm install
npm run seed                    # usuario demo + cinco negocios con reseñas de ejemplo
npm run dev
```

Para todo en Docker (base de datos, API y frontend con nginx): `docker compose up -d --build` → http://localhost:8090

## IA
El motor de IA se elige con `AI_PROVIDER` (por defecto `auto`):
- Con `GEMINI_API_KEY` → **Gemini** (`gemini-3.5-flash`, plan gratuito, con `gemini-flash-lite-latest` de respaldo).
- Con `ANTHROPIC_API_KEY` → **Claude** (`claude-opus-5`); tiene prioridad si están las dos.
- Sin ninguna clave → **analizador léxico local** en español (gratis y sin red).

La clave de API va **solo** en `.env` o en las variables de entorno del servidor; nunca en el código.

## Scripts

| Script | |
|---|---|
| `npm run dev` | API con recarga automática |
| `npm test` | 78 pruebas (dominio, casos de uso, IA, HTTP); con `TEST_DATABASE_URL`, 8 más contra PostgreSQL |
| `npm run typecheck` | chequeo de tipos |
| `npm run check` | lint y formato con Biome |
| `npm run eval` | exactitud del sentimiento: léxico local vs. Gemini (`-- --guardar` escribe `docs/EVALUACION.md`) |
| `npm run seed` | datos de demostración (idempotente; no corre en producción). Con `-- --hasta 30/09/2026` carga solo hasta esa fecha: así se arma un historial de dos análisis para ver la evolución |
| `npm run build` / `npm start` | build y ejecución de producción |

Pruebas contra PostgreSQL real (la base debe terminar en `_test`, porque se borra su esquema):

```bash
docker exec pulso_local-db-1 psql -U pulso -d pulsolocal -c "CREATE DATABASE pulsolocal_test"
TEST_DATABASE_URL=postgres://pulso:pulso_dev_password@localhost:5434/pulsolocal_test npm test
```

El CI de GitHub Actions corre Biome, tipos, todas las pruebas (con un PostgreSQL desechable), `npm audit` y el build.

## Formato del CSV

```csv
fecha;comentario;calificacion
02/08/2026;El café es delicioso;5
03/08/2026;Me demoraron 35 minutos un tinto;2
```

Acepta coma o punto y coma como separador. Columnas reconocidas: `comentario` / `texto` / `reseña` (obligatoria),
`calificacion` / `estrellas` (1–5) y `fecha` (dd/mm/aaaa o ISO). Hay ejemplos en [samples/](samples/).
