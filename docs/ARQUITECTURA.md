# PulsoLocal — Documento de arquitectura (avance 1)

**Curso:** Programación Orientada a la Web · 7.º semestre · Ingeniería de Software · UCC Pasto
**Tipo:** proyecto final individual
**Fecha del avance:** 13 de octubre de 2026 (avance 2)

---

## 1. Problema y propuesta

Un negocio pequeño (cafetería, restaurante, peluquería, tienda) recibe decenas de reseñas en Google Maps,
Instagram o WhatsApp, pero el dueño no tiene tiempo ni conocimientos para analizarlas. El promedio de estrellas
no le dice **qué** mejorar.

**PulsoLocal** recibe las reseñas en texto crudo (CSV o pegadas) y usa un modelo de lenguaje (LLM) para:

1. **Descubrir los temas recurrentes** (topic modeling): "tiempo de espera", "atención", "precio"…
2. **Clasificar cada reseña**: sentimiento (positivo/neutro/negativo con puntaje de −1 a 1) y temas que menciona.
3. **Redactar recomendaciones de negocio** concretas y priorizadas, por ejemplo: *"Reduce la espera en horas pico:
   el 12,5 % de tus reseñas se queja del tiempo de espera"*.

**Diferencial:** no es otro gráfico de estrellas. Convierte texto libre en acciones, y **cada cifra que aparece en
una recomendación la calcula el código, no el LLM**. Así el modelo no puede inventarse porcentajes.

---

## 2. Stack

| Capa | Tecnología | Por qué |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS 4 | SPA tipada; Tailwind ya se usa en el curso |
| Backend | Node.js 22 + Express 5 + TypeScript | Express 5 maneja errores `async` de forma nativa |
| Base de datos | PostgreSQL 17 | Relacional (el modelo lo es), transacciones, `JSONB` para las citas |
| IA | API de Claude (Anthropic), modelo `claude-opus-5` | Salidas estructuradas validadas con Zod y buen rendimiento en español |
| IA de respaldo | Analizador léxico propio en español | Funciona sin red ni costo, y sirve para las pruebas automáticas |
| Infraestructura | Docker Compose (db + api + nginx) | Todo el entorno se levanta con un comando |
| Pruebas | Vitest + Supertest | 41 pruebas: dominio, casos de uso, infraestructura e integración HTTP |

---

## 3. Diagrama de componentes

```
┌──────────────────────────── Navegador ────────────────────────────┐
│  React SPA                                                        │
│  pages/  →  components/  →  api/services.ts  →  api/http.ts       │
│  (Login, Negocios, Dashboard)      (fetch + cookie + header CSRF) │
└───────────────────────────────┬───────────────────────────────────┘
                                │ HTTPS  /api/*
┌───────────────────────────────▼───────────────────────────────────┐
│ nginx (sirve la SPA + proxy inverso + cabeceras de seguridad)     │
└───────────────────────────────┬───────────────────────────────────┘
┌───────────────────────────────▼───────────────────────────────────┐
│ API Express (arquitectura hexagonal)                              │
│                                                                   │
│  interfaces/http   middlewares · schemas Zod · controllers        │
│        │                                                          │
│  application       casos de uso (RegisterUser, ImportReviews,     │
│        │           RequestAnalysis, ExecuteAnalysis, GetDashboard)│
│        │                                                          │
│  domain            entidades · value objects · InsightAggregator  │
│        │           puertos (interfaces) ◄─────────────┐           │
│        │                                              │ implementa│
│  infrastructure    PgRepositories · JwtTokenService · │           │
│                    ClaudeReviewAnalyzer / Heuristic ──┘           │
│                    InMemoryTaskScheduler (cola de análisis)       │
└──────────┬──────────────────────────────────────┬─────────────────┘
           │ SQL parametrizado                    │ HTTPS
┌──────────▼──────────┐                 ┌─────────▼─────────┐
│  PostgreSQL         │                 │  API de Claude    │
└─────────────────────┘                 └───────────────────┘
```

**Regla de dependencias:** las flechas apuntan hacia adentro. `domain` no importa nada de Express, `pg` ni del
SDK de Anthropic. La infraestructura implementa las interfaces (puertos) que define el dominio.

---

## 4. Estructura de carpetas

```
Pulso_local/
├── docker-compose.yml         db + backend + frontend
├── .env.example               variables documentadas (el .env real no se versiona)
├── samples/                   CSV de ejemplo (40 reseñas de una cafetería de Pasto)
├── docs/ARQUITECTURA.md       este documento
├── backend/
│   ├── src/
│   │   ├── domain/            ← núcleo, sin dependencias externas
│   │   │   ├── entities/      User, Business, Review, AnalysisRun
│   │   │   ├── value-objects/ Email, Sentiment, Rating
│   │   │   ├── model/         tipos del análisis (TopicStat, Recommendation…)
│   │   │   ├── services/      InsightAggregator (cálculo puro de cifras)
│   │   │   ├── ports/         interfaces: repositorios, ReviewAnalyzer, servicios
│   │   │   └── errors/        jerarquía DomainError
│   │   ├── application/use-cases/   un caso de uso = una clase con execute()
│   │   ├── infrastructure/
│   │   │   ├── db/            Database, migraciones SQL, repositorios Pg*
│   │   │   ├── ai/            ClaudeReviewAnalyzer, HeuristicReviewAnalyzer, prompts, Factory
│   │   │   ├── security/      BcryptPasswordHasher, JwtTokenService
│   │   │   ├── csv/           parsers de CSV y texto pegado
│   │   │   └── jobs/          InMemoryTaskScheduler
│   │   ├── interfaces/http/   controllers, middlewares, schemas, routes
│   │   ├── container.ts       raíz de composición (inyección de dependencias)
│   │   ├── app.ts             construcción de Express
│   │   └── server.ts          arranque y apagado ordenado
│   └── tests/                 dominio, casos de uso (con repos en memoria), infraestructura
└── frontend/
    └── src/
        ├── api/               HttpClient, servicios por recurso, tipos
        ├── auth/              AuthContext + guardia de rutas
        ├── components/        ui, charts, insights, ReviewsTable, ImportPanel
        ├── hooks/             useAnalysisPolling
        └── pages/             AuthPage, BusinessesPage, DashboardPage
```

---

## 5. Modelo de datos

```
users 1───N businesses 1───N reviews
                  │
                  1
                  │
                  N
            analysis_runs 1───N review_sentiments N───1 reviews
                  │
                  ├──1───N topics ───N:M (review_topics)─── reviews
                  │
                  └──1───N recommendations N───0..1 topics
```

| Tabla | Propósito | Restricciones clave |
|---|---|---|
| `users` | Dueños de negocio | `email` único; solo se guarda el hash bcrypt |
| `businesses` | Negocios de cada usuario | FK `owner_id`, `CHECK` de categoría |
| `reviews` | Reseñas crudas | `UNIQUE(business_id, content_hash)` para deduplicar; `CHECK` de longitud y de estrellas |
| `analysis_runs` | Cada ejecución de la IA | `CHECK` de estado; guarda el proveedor usado (trazabilidad) |
| `review_sentiments` | Sentimiento por reseña **y por análisis** | Guarda el histórico: un nuevo análisis no sobrescribe el anterior |
| `topics` | Temas detectados, con sus cifras | `UNIQUE(run_id, key)`; `sample_quotes` en JSONB |
| `review_topics` | Relación N:M reseña–tema | PK compuesta |
| `recommendations` | Recomendaciones ordenadas | `CHECK` de prioridad, `evidence_share` calculado por el código |

Las migraciones son archivos SQL versionados (`001_initial_schema.sql`). Un migrador propio las aplica en orden,
cada una en su propia transacción, y lleva el control en la tabla `schema_migrations`.

---

## 6. Pipeline de IA

```
POST /businesses/:id/analyses ──► RequestAnalysis ──► 202 Accepted { runId, status: "pending" }
                                         │
                                         ▼ (cola en segundo plano)
                                  ExecuteAnalysis
   ┌──────────────────────────────────────────────────────────────────────┐
   │ 1. discoverTopics(muestra de ≤120 reseñas)   → 4–8 temas (LLM)        │
   │ 2. classify(lotes de 40, 2 en paralelo)      → sentimiento + temas    │
   │ 3. InsightAggregator.aggregate()             → conteos y % (CÓDIGO)   │
   │ 4. recommend(cifras ya calculadas)           → 3–5 borradores (LLM)   │
   │ 5. rankRecommendations()                     → orden + evidencia      │
   │ 6. completeWithResults() en UNA transacción                          │
   └──────────────────────────────────────────────────────────────────────┘
El frontend consulta GET /analyses/:id cada 1,5 s hasta ver "completed" o "failed".
```

**Por qué se separa en tres llamadas y no en una:** si se clasifican 500 reseñas en lotes y cada lote inventa sus
propios temas, aparecen "demora", "tiempo de espera" y "lentitud" como tres temas distintos. Primero se fija una
**taxonomía** y después todas las reseñas se clasifican contra ella. Así el topic modeling queda consistente.

**Salidas estructuradas:** cada llamada define un esquema Zod (`betaZodOutputFormat`). La API devuelve JSON con
esa forma y el SDK lo valida. Aun así, el código descarta los IDs que no estaban en el lote y los temas que no
pertenecen a la taxonomía (ver prueba *"descarta IDs y temas que el modelo invente"*).

**Esfuerzo por paso:** `low` para clasificar (tarea sencilla y de alto volumen), `medium` para descubrir temas y
`high` para las recomendaciones (requieren razonar). Esto controla el costo sin perder calidad.

**Respaldo:** si el clasificador de seguridad de la API rechaza una petición, el parámetro `fallbacks: "default"`
la reintenta en el servidor con otro modelo.

---

## 7. Patrones de diseño aplicados

| Patrón | Dónde | Qué resuelve |
|---|---|---|
| **Arquitectura hexagonal (puertos y adaptadores)** | Toda la estructura del backend | El dominio no depende de frameworks; se prueba sin base de datos |
| **Strategy** | `ReviewAnalyzer` → `ClaudeReviewAnalyzer` / `HeuristicReviewAnalyzer` | Cambiar el motor de IA sin tocar los casos de uso |
| **Factory** | `createReviewAnalyzer()` | Elige la estrategia según la configuración |
| **Adapter** | `ClaudeReviewAnalyzer`, `CsvReviewParser` | Traduce APIs y formatos externos al lenguaje del dominio |
| **Repository + Data Mapper** | `Pg*Repository` con `toDomain()` | Separa la persistencia de las entidades |
| **Unit of Work** (transacción) | `completeWithResults()`, `Database.transaction()` | Un análisis se guarda completo o no se guarda |
| **State (máquina de estados)** | `AnalysisRun`: pending → running → completed / failed | Imposible quedar en un estado incoherente |
| **Command / Use Case** | Una clase por caso de uso con `execute()` | Responsabilidad única y fácil de probar |
| **Value Object** | `Email`, `Sentiment`, `Rating` | Validación en un solo lugar; inmutables |
| **Composition Root / DI** | `container.ts` | El único lugar donde se usa `new` sobre clases concretas |
| **Facade** | `HttpClient` en el frontend | Un único punto que añade la cookie, el header CSRF y los errores tipados |
| **Domain Service** | `InsightAggregator`, `InsightComparator` | Cálculos puros del negocio (cifras y evolución) sin E/S, fáciles de probar |
| **CQRS ligero** | `GetDashboard`, `ReviewRepository.search()` | Consultas de lectura optimizadas, separadas de los comandos |

### Programación orientada a objetos

- **Encapsulamiento:** las entidades tienen constructor privado y se crean con `create()` (valida las reglas) o con
  `restore()` (reconstruye desde la BD). El estado solo se lee con getters y solo cambia mediante métodos con reglas
  (`run.start()`, `run.fail()`).
- **Abstracción:** los casos de uso dependen de interfaces (`UserRepository`, `ReviewAnalyzer`), no de clases concretas.
- **Polimorfismo:** `ClaudeReviewAnalyzer` y `HeuristicReviewAnalyzer` se usan de manera intercambiable; en las
  pruebas se inyectan analizadores falsos que fallan o que "alucinan".
- **Herencia:** jerarquía `DomainError` → `ValidationError`, `NotFoundError`, `ConflictError`, `AnalyzerError`,
  `AuthenticationError`. El manejador HTTP traduce cada tipo a un código de estado.
- **SOLID:** responsabilidad única (un caso de uso por clase), abierto/cerrado (un nuevo proveedor de IA se agrega
  sin modificar código existente), inversión de dependencias (`container.ts`).

---

## 8. Seguridad

| Amenaza (OWASP) | Control implementado | Dónde |
|---|---|---|
| Inyección SQL | Solo consultas parametrizadas; incluso los filtros dinámicos usan `$n` | `Pg*Repository` |
| Robo de sesión por XSS | JWT en cookie `httpOnly`, `SameSite=Strict` y `Secure` en producción; React escapa todo el texto (no se usa `dangerouslySetInnerHTML`) | `AuthController`, frontend |
| CSRF | Cookie `SameSite=Strict` y header obligatorio `X-Requested-With` en todo método que modifica estado | `requireCsrfHeader` |
| IDOR (acceder a negocios ajenos) | `BusinessAccess.requireOwned()` en **todos** los casos de uso; responde 404 para no revelar si el negocio existe | `BusinessAccess`, `Business.assertOwnedBy` |
| Fuerza bruta | Rate limit de 10 intentos cada 15 min en login y registro; bcrypt con costo 12 | `authLimiter`, `BcryptPasswordHasher` |
| Enumeración de usuarios | Mismo mensaje para correo inexistente y contraseña errada, **y el mismo tiempo de respuesta** (hash señuelo) | `AuthenticateUser` |
| Contraseñas débiles | Mínimo 10 caracteres, letras y números, no puede contener el correo, máximo de 72 bytes (límite de bcrypt) | `RegisterUser` |
| Manipulación del JWT | Algoritmo fijado a HS256 (bloquea `alg: none`), con validación de emisor, audiencia y vencimiento | `JwtTokenService` |
| Mass assignment | Esquemas Zod `.strict()`: se rechaza cualquier campo no declarado (p. ej. `ownerId`) | `schemas.ts` |
| Subida de archivos maliciosos | Solo en memoria, máx. 1 MB, extensión y MIME en lista blanca, UTF-8 estricto y sin bytes nulos | `routes.ts`, `ReviewController` |
| **Prompt injection** | Reseñas encerradas en etiquetas XML y escapadas (`<` → `&lt;`); el system prompt ordena tratarlas como datos; salida restringida por esquema y validada en el código | `prompts.ts`, `ExecuteAnalysis` |
| CSV / formula injection | Al exportar, las celdas que empiezan por `= + - @` se neutralizan con `'`; nombre de archivo saneado | `CsvReviewExporter`, `ReviewController` |
| Abuso de costos de IA | Máx. 500 reseñas por análisis, 20 análisis por hora por usuario y un solo análisis en curso por negocio | `RequestAnalysis`, `analysisLimiter` |
| Fuga de información | Manejador central: los errores 500 son genéricos; la traza solo va al log, y los logs ocultan cookies y contraseñas | `errorHandler`, `pino.redact` |
| Cabeceras | Helmet (CSP, HSTS, nosniff, frameguard), `x-powered-by` desactivado, `Cache-Control: no-store` en la API | `app.ts` |
| CORS | Lista blanca de un solo origen, con credenciales | `app.ts` |
| Secretos | Configuración validada al arrancar (fail-fast); `JWT_SECRET` de al menos 32 caracteres, y en producción se rechazan valores de ejemplo | `config/env.ts` |
| Contenedores | Usuario sin privilegios (`USER node`, nginx-unprivileged), sistema de archivos de solo lectura, `no-new-privileges`, BD expuesta solo en `127.0.0.1` | `Dockerfile`, `docker-compose.yml` |

### Verificación manual realizada (curl contra la API)

| Prueba | Resultado |
|---|---|
| Login sin header CSRF | `403 CSRF_REJECTED` ✔ |
| Contraseña incorrecta | `401 Credenciales inválidas` ✔ |
| `POST /businesses` con `ownerId` inyectado | `400 Unrecognized key "ownerId"` ✔ |
| Dashboard sin sesión | `401` ✔ |
| ID con `' OR 1=1--` | `400 Identificador no válido` ✔ |
| Otro usuario lee o borra el negocio | `404 Negocio no encontrado` ✔ |
| Búsqueda con `%` | Se busca literal (0 resultados) ✔ |
| Subir un `.exe` | `400 Solo se aceptan archivos .csv` ✔ |

---

## 9. API REST

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/auth/register` | Crear cuenta (e iniciar sesión) |
| POST | `/api/auth/login` | Iniciar sesión (cookie httpOnly) |
| POST | `/api/auth/logout` | Cerrar sesión |
| GET | `/api/auth/me` | Usuario actual |
| GET/POST | `/api/businesses` | Listar / crear negocios |
| GET/DELETE | `/api/businesses/:id` | Ver / eliminar negocio |
| GET | `/api/businesses/:id/reviews?sentiment=&topic=&q=&limit=&offset=` | Reseñas con filtros |
| POST | `/api/businesses/:id/reviews/csv` | Importar un CSV (multipart, campo `file`) |
| POST | `/api/businesses/:id/reviews/text` | Importar texto pegado |
| GET | `/api/businesses/:id/reviews/export` | Descargar CSV con sentimiento y temas |
| DELETE | `/api/businesses/:id/reviews` | Borrar todas las reseñas |
| POST | `/api/businesses/:id/analyses` | Lanzar un análisis (202 Accepted) |
| GET | `/api/analyses/:id` | Estado del análisis |
| GET | `/api/businesses/:id/dashboard` | Reporte completo + comparación con el análisis anterior |
| GET | `/api/health` | Estado de la BD y proveedor de IA activo |

---

## 10. Estado del avance y próximos pasos

**Avance 1 (29 sep)**
- [x] Arquitectura hexagonal, autenticación segura, CRUD de negocios, importación CSV/texto con deduplicación.
- [x] Pipeline de IA en 3 pasos (Claude + respaldo heurístico) y dashboard con KPIs, sentimiento, temas y recomendaciones.
- [x] Docker Compose y despliegue: backend + PostgreSQL en Render, frontend en Vercel (proxy `/api`).

**Avance 2 (13 oct)**
- [x] **Evolución en el tiempo:** `InsightComparator` compara el último análisis con el anterior (sentimiento y
  quejas por tema: mejoró / empeoró / estable / nuevo / resuelto). La IA recibe la taxonomía anterior y reutiliza
  sus keys para que la comparación sea válida.
- [x] **Exportación CSV** con protección contra *formula injection*; **reporte imprimible en PDF** desde el navegador.
- [x] **Pruebas de integración HTTP** (Supertest): cabeceras, CSRF, sesión manipulada, IDOR, mass assignment,
  subida de archivos y flujo completo. `createApp` depende de la interfaz `AppDependencies` (no de la clase concreta).
- [x] Rediseño visual del frontend.

**Pendiente**
1. Probar el pipeline con una clave real de Claude y medir su exactitud frente al heurístico (~100 reseñas etiquetadas a mano).
2. Cola persistente (BullMQ + Redis) en lugar de la cola en memoria.
3. Pruebas end-to-end del frontend (Playwright).
4. Rate limit por IP real detrás del proxy de Vercel.
