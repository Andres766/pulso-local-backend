# PulsoLocal

**Dashboard de insights automáticos para negocios pequeños.** El dueño carga las reseñas de sus clientes y
PulsoLocal usa IA para detectar temas recurrentes, medir el sentimiento y generar recomendaciones concretas,
respaldadas con cifras reales.

> Proyecto final · Programación Orientada a la Web · Ingeniería de Software · UCC Pasto

La arquitectura, los patrones, el modelo de datos y la seguridad se explican en **[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)**.

## Requisitos
- Node.js 22 o superior
- Docker Desktop

## Opción A · Desarrollo (recomendada para la demo)

```bash
# 1. Variables de entorno
cp .env.example .env            # y completar JWT_SECRET (ver comentario en el archivo)
cp .env backend/.env

# 2. Base de datos (PostgreSQL en el puerto 5434)
docker compose up -d db

# 3. Backend (http://localhost:4000)
cd backend
npm install
npm run seed                    # usuario demo + 40 reseñas de ejemplo
npm run dev

# 4. Frontend (http://localhost:5180), en otra terminal
cd frontend
npm install
npm run dev
```

**Usuario demo:** `demo@pulsolocal.co` / `Galeras2026Pasto`

## Opción B · Todo en Docker

```bash
docker compose up -d --build    # http://localhost:8090
```

## IA
- Con `ANTHROPIC_API_KEY` en `.env`, el análisis usa **Claude** (`claude-opus-5`).
- Sin clave, usa el **analizador léxico local** en español (gratis y sin red). El dashboard indica qué motor
  generó cada reporte.

## Pruebas

```bash
cd backend
npm test            # 41 pruebas (dominio, casos de uso, infraestructura, HTTP)
npm run typecheck
```

## Formato del CSV

```csv
fecha;comentario;calificacion
02/08/2026;El café es delicioso;5
03/08/2026;Me demoraron 35 minutos un tinto;2
```

Acepta coma o punto y coma como separador. Columnas reconocidas: `comentario` / `texto` / `reseña` (obligatoria),
`calificacion` / `estrellas` (1–5) y `fecha` (dd/mm/aaaa o ISO). Hay un ejemplo en [samples/](samples/).
