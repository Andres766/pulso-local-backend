# PulsoLocal — Documento de arquitectura (avance 1)

**Curso:** Programación Orientada a la Web · 7.º semestre · Ingeniería de Software · UCC Pasto
**Tipo:** proyecto final individual
**Fecha del avance:** 2 de noviembre de 2026 (avance 4)

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
| IA (en uso) | API de **Gemini** (Google), modelo `gemini-3.5-flash` con respaldo `gemini-flash-lite-latest` | Plan gratuito; salida JSON restringida por esquema y validada con Zod |
| IA (alternativa) | API de Claude (Anthropic), modelo `claude-opus-5` | Mismo contrato: se activa solo con poner `ANTHROPIC_API_KEY` |
| IA de respaldo | Analizador léxico propio en español | Funciona sin red ni costo, y sirve para las pruebas automáticas |
| Infraestructura | Docker Compose (db + api + nginx) | Todo el entorno se levanta con un comando |
| Pruebas | Vitest, Supertest, Testing Library, Playwright | Backend: 86 (dominio, casos de uso, HTTP y 8 contra PostgreSQL real). Frontend: 26 unitarias y 5 end-to-end |
| Calidad | Biome, GitHub Actions, `npm audit` | Lint y formato; CI en cada push (con PostgreSQL desechable); 0 vulnerabilidades |

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
│                    Gemini / Claude / Heuristic ───────┘           │
│                    PollingJobRunner (cola persistente en la BD)   │
└──────────┬──────────────────────────────────────┬─────────────────┘
           │ SQL parametrizado                    │ HTTPS
┌──────────▼──────────┐                 ┌─────────▼─────────┐
│  PostgreSQL         │                 │ API Gemini/Claude │
└─────────────────────┘                 └───────────────────┘
```

**Regla de dependencias:** las flechas apuntan hacia adentro. `domain` no importa nada de Express, `pg` ni del
SDK de Google o de Anthropic. La infraestructura implementa las interfaces (puertos) que define el dominio.

---

## 4. Estructura de carpetas

```
backend/  (repositorio pulso-local-backend)
├── src/
│   ├── domain/                 ← núcleo, sin dependencias externas
│   │   ├── entities/           User, Business, Review, AnalysisRun
│   │   ├── value-objects/      Email, Sentiment, Rating
│   │   ├── model/              tipos del análisis (TopicStat, Recommendation…) y LlmUsage/UsageMeter
│   │   ├── services/           InsightAggregator, InsightComparator, SentimentTrend (cálculos puros)
│   │   ├── ports/              interfaces: repositorios, ReviewAnalyzer, JobQueue, SessionValidator…
│   │   └── errors/             jerarquía DomainError
│   ├── application/
│   │   ├── use-cases/          un caso de uso = una clase con execute(); AnalysisWorker consume la cola
│   │   └── evaluation/         métricas de exactitud (precisión, cobertura, F1, matriz de confusión)
│   ├── infrastructure/
│   │   ├── db/                 Database, migraciones SQL (001–005), repositorios Pg*, seed
│   │   ├── ai/                 LlmReviewAnalyzer (abstracta) → Gemini/Claude; Heuristic; prompts; Factory
│   │   ├── security/           BcryptPasswordHasher, JwtTokenService
│   │   ├── csv/                parsers de entrada y exportador con protección contra formula injection
│   │   └── jobs/               PollingJobRunner (cuándo mirar la cola)
│   ├── interfaces/http/        controllers, middlewares (seguridad, request ID, errores), schemas, routes, openapi
│   ├── scripts/evaluate.ts     npm run eval
│   ├── container.ts            raíz de composición (inyección de dependencias)
│   ├── app.ts                  construcción de Express a partir de AppDependencies
│   └── server.ts               arranque, recuperación de la cola y apagado ordenado
├── tests/                      dominio, casos de uso, HTTP (Supertest), IA y db/ (PostgreSQL real)
├── samples/                    CSV de ejemplo (cafetería y restaurante) y conjunto de evaluación etiquetado
└── .github/workflows/ci.yml

frontend/  (repositorio pulso-local---frontend)
├── src/api/                    HttpClient (fachada), servicios por recurso, tipos del contrato
├── src/auth/                   AuthContext, guardia de rutas, safeRedirect
├── src/components/             UI, gráficos, toasts, diálogo de confirmación, ErrorBoundary…
├── src/pages/                  Auth, Negocios, Dashboard, Mi cuenta, 404 (carga diferida)
└── e2e/                        pruebas end-to-end con Playwright
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
| `users` | Dueños de negocio | `email` único; solo el hash bcrypt; `failed_logins`/`locked_until` (bloqueo) y `token_version` (sesiones) |
| `businesses` | Negocios de cada usuario | FK `owner_id`, `CHECK` de categoría |
| `reviews` | Reseñas crudas | `UNIQUE(business_id, content_hash)` para deduplicar; `CHECK` de longitud y de estrellas |
| `analysis_runs` | Cada ejecución de la IA **y cola de trabajos** | `CHECK` de estado; proveedor usado; `attempts`/`available_at` (reintentos); llamadas y tokens consumidos; índice parcial de pendientes |
| `review_sentiments` | Sentimiento por reseña **y por análisis** | Guarda el histórico: un nuevo análisis no sobrescribe el anterior |
| `topics` | Temas detectados, con sus cifras | `UNIQUE(run_id, key)`; `sample_quotes` en JSONB |
| `review_topics` | Relación N:M reseña–tema | PK compuesta |
| `recommendations` | Recomendaciones ordenadas | `CHECK` de prioridad, `evidence_share` calculado por el código |

Las migraciones son archivos SQL versionados (`001` esquema inicial, `002` cola persistente, `003` bloqueo de cuenta, `004` versión de sesión, `005` consumo de IA). Un migrador propio las aplica en orden,
cada una en su propia transacción, y lleva el control en la tabla `schema_migrations`.

---

## 6. Pipeline de IA

```
POST /businesses/:id/analyses ──► RequestAnalysis ──► guarda el run "pending" ──► 202 Accepted
                                                           │ (wake)
                                    PollingJobRunner ◄─────┘   también revisa la cola cada 15 s
                                           │
                                  AnalysisWorker.claimNext()   FOR UPDATE SKIP LOCKED
                                           │
                                  ExecuteAnalysis.process(run)
   ┌──────────────────────────────────────────────────────────────────────┐
   │ 1. discoverTopics(muestra ≤120, taxonomía anterior) → 4–8 temas (LLM) │
   │ 2. classify(lotes de 40, 2 en paralelo)      → sentimiento + temas    │
   │ 3. InsightAggregator.aggregate()             → conteos y % (CÓDIGO)   │
   │ 4. recommend(cifras ya calculadas)           → 3–5 borradores (LLM)   │
   │ 5. rankRecommendations()                     → orden + evidencia      │
   │ 6. completeWithResults() en UNA transacción (+ tokens consumidos)    │
   └──────────────────────────────────────────────────────────────────────┘
   Error transitorio de la IA (429/503) → vuelve a la cola: 30 s, 60 s… hasta 3 intentos.
   Reinicio del servidor a mitad de un análisis → al arrancar vuelve a la cola (no se pierde).
El frontend consulta GET /analyses/:id cada 1,5 s y muestra el avance (incluido "reintentando").
```

**Por qué se separa en tres llamadas y no en una:** si se clasifican 500 reseñas en lotes y cada lote inventa sus
propios temas, aparecen "demora", "tiempo de espera" y "lentitud" como tres temas distintos. Primero se fija una
**taxonomía** y después todas las reseñas se clasifican contra ella. Así el topic modeling queda consistente.

**Salidas estructuradas:** cada llamada define un esquema Zod; Gemini recibe su JSON Schema
(`responseJsonSchema`) y Claude usa `betaZodOutputFormat`. La respuesta se vuelve a validar con Zod. Aun así, el código descarta los IDs que no estaban en el lote y los temas que no
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
| **Strategy** | `ReviewAnalyzer` → `GeminiReviewAnalyzer` / `ClaudeReviewAnalyzer` / `HeuristicReviewAnalyzer` | Cambiar el motor de IA sin tocar los casos de uso |
| **Template Method** | `LlmReviewAnalyzer` (abstracta) define el algoritmo; cada LLM solo implementa `generate()` | Gemini y Claude comparten prompts, alias y traducción al dominio sin duplicar código |
| **Factory** | `createReviewAnalyzer()` | Elige la estrategia según la configuración |
| **Adapter** | `GeminiReviewAnalyzer`, `ClaudeReviewAnalyzer`, `CsvReviewParser` | Traduce APIs y formatos externos al lenguaje del dominio |
| **Repository + Data Mapper** | `Pg*Repository` con `toDomain()` | Separa la persistencia de las entidades |
| **Unit of Work** (transacción) | `completeWithResults()`, `Database.transaction()` | Un análisis se guarda completo o no se guarda |
| **State (máquina de estados)** | `AnalysisRun`: pending → running → completed / failed | Imposible quedar en un estado incoherente |
| **Command / Use Case** | Una clase por caso de uso con `execute()` | Responsabilidad única y fácil de probar |
| **Value Object** | `Email`, `Sentiment`, `Rating` | Validación en un solo lugar; inmutables |
| **Composition Root / DI** | `container.ts` | El único lugar donde se usa `new` sobre clases concretas |
| **Facade** | `HttpClient` en el frontend | Un único punto que añade la cookie, el header CSRF y los errores tipados |
| **Domain Service** | `InsightAggregator`, `InsightComparator`, `SentimentTrend` | Cálculos puros del negocio (cifras y evolución) sin E/S, fáciles de probar |
| **Productor–consumidor (cola de trabajos)** | `RequestAnalysis` encola; `AnalysisWorker` consume con `claimNext()`; `PollingJobRunner` decide cuándo | El análisis no bloquea la petición HTTP y sobrevive a reinicios |
| **CQRS ligero** | `GetDashboard`, `ReviewRepository.search()` | Consultas de lectura optimizadas, separadas de los comandos |

### Programación orientada a objetos

- **Encapsulamiento:** las entidades tienen constructor privado y se crean con `create()` (valida las reglas) o con
  `restore()` (reconstruye desde la BD). El estado solo se lee con getters y solo cambia mediante métodos con reglas
  (`run.start()`, `run.fail()`).
- **Abstracción:** los casos de uso dependen de interfaces (`UserRepository`, `ReviewAnalyzer`), no de clases concretas.
- **Polimorfismo:** `GeminiReviewAnalyzer`, `ClaudeReviewAnalyzer` y `HeuristicReviewAnalyzer` se usan de manera
  intercambiable; en las pruebas se inyectan analizadores y clientes de API falsos que fallan, se saturan o "alucinan".
- **Herencia:** `LlmReviewAnalyzer` (clase abstracta) → `GeminiReviewAnalyzer` y `ClaudeReviewAnalyzer`; jerarquía `DomainError` → `ValidationError`, `NotFoundError`, `ConflictError`, `AnalyzerError`,
  `AuthenticationError`. El manejador HTTP traduce cada tipo a un código de estado.
- **SOLID:** responsabilidad única (un caso de uso por clase), abierto/cerrado (Gemini se agregó como una subclase
  nueva sin modificar los casos de uso), inversión de dependencias (`container.ts`).

---

## 8. Seguridad

| Amenaza (OWASP) | Control implementado | Dónde |
|---|---|---|
| Inyección SQL | Solo consultas parametrizadas; incluso los filtros dinámicos usan `$n` | `Pg*Repository` |
| Robo de sesión por XSS | JWT en cookie `httpOnly`, `SameSite=Strict` y `Secure` en producción; React escapa todo el texto (no se usa `dangerouslySetInnerHTML`) | `AuthController`, frontend |
| CSRF | Cookie `SameSite=Strict` y header obligatorio `X-Requested-With` en todo método que modifica estado | `requireCsrfHeader` |
| IDOR (acceder a negocios ajenos) | `BusinessAccess.requireOwned()` en **todos** los casos de uso; responde 404 para no revelar si el negocio existe | `BusinessAccess`, `Business.assertOwnedBy` |
| Fuerza bruta | Límite de 10 fallos / 15 min por **IP + correo** y 50 / 15 min por IP (relleno de credenciales); **bloqueo de la cuenta 15 min** tras 5 fallos seguidos, aunque vengan de muchas IP; bcrypt con costo 12 | `authLimiter`, `authIpLimiter`, `User.registerFailedLogin`, `BcryptPasswordHasher` |
| Sesión robada | **Versión de sesión** dentro del JWT: cambiar la contraseña invalida al instante todos los tokens anteriores; `requireAuth` verifica firma y versión vigente | `ValidateSession`, `ChangePassword` |
| Datos personales (Ley 1581 de 2012) | Derecho de supresión: eliminar la cuenta borra en cascada negocios, reseñas y análisis; pide la contraseña | `DeleteAccount` |
| Enumeración de usuarios | Mismo mensaje para correo inexistente y contraseña errada, **y el mismo tiempo de respuesta** (hash señuelo) | `AuthenticateUser` |
| Contraseñas débiles | Mínimo 10 caracteres, letras y números, no puede contener el correo, máximo de 72 bytes (límite de bcrypt) | `RegisterUser` |
| Manipulación del JWT | Algoritmo fijado a HS256 (bloquea `alg: none`), con validación de emisor, audiencia y vencimiento | `JwtTokenService` |
| Mass assignment | Esquemas Zod `.strict()`: se rechaza cualquier campo no declarado (p. ej. `ownerId`) | `schemas.ts` |
| Subida de archivos maliciosos | Solo en memoria, máx. 1 MB, extensión y MIME en lista blanca, UTF-8 estricto y sin bytes nulos | `routes.ts`, `ReviewController` |
| **Prompt injection** | Reseñas encerradas en etiquetas XML y escapadas (`<` → `&lt;`); el system prompt ordena tratarlas como datos; salida restringida por esquema y validada en el código | `prompts.ts`, `ExecuteAnalysis` |
| CSV / formula injection | Al exportar, las celdas que empiezan por `= + - @` se neutralizan con `'`; nombre de archivo saneado | `CsvReviewExporter`, `ReviewController` |
| Abuso de costos de IA | Máx. 500 reseñas por análisis, 20 análisis por hora por usuario y un solo análisis en curso por negocio | `RequestAnalysis`, `analysisLimiter` |
| Fuga de información | Manejador central: los errores 500 son genéricos y solo traen un `requestId` para buscar la traza en los logs; los logs ocultan cookies y contraseñas | `errorHandler`, `requestId`, `pino.redact` |
| Open redirect (frontend) | Tras el login solo se aceptan rutas internas: se rechazan `//`, `/\` y caracteres de control | `safeRedirect` |
| Dependencias vulnerables | `npm audit` en el CI (falla con severidad alta); se corrigieron body-parser, multer y Vite | `.github/workflows/ci.yml` |
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
| 5 contraseñas erradas y luego la correcta | `423 ACCOUNT_LOCKED` (15 minutos) ✔ |
| Cambiar la contraseña con dos sesiones abiertas | la otra sesión recibe `401` ✔ |
| Eliminar la cuenta | 0 usuarios, negocios y reseñas en la base ✔ |
| Matar el servidor a mitad de un análisis | al volver se recuperó y completó en el segundo intento ✔ |
| `sort=r.rating; DROP TABLE reviews` | `400` (lista blanca) ✔ |

---

## 9. API REST

El contrato completo (23 operaciones, con parámetros, cuerpos y errores) está en **`GET /api/openapi.json`**
(OpenAPI 3.1; se abre en https://editor.swagger.io). Una prueba recorre las rutas registradas en Express y falla
si alguna no está documentada.

| Grupo | Operaciones |
|---|---|
| Sistema | `GET /health` (estado, versión, tiempo en línea) · `GET /openapi.json` |
| Autenticación | `POST /auth/register` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/password` · `DELETE /auth/account` |
| Negocios | `GET`/`POST /businesses` · `GET`/`PATCH`/`DELETE /businesses/:id` |
| Reseñas | `GET /businesses/:id/reviews` (filtros, orden, paginación) · `POST …/reviews/csv` · `POST …/reviews/text` · `GET …/reviews/export` · `DELETE …/reviews` · `DELETE …/reviews/:reviewId` |
| Análisis | `POST /businesses/:id/analyses` (202) · `GET /analyses/:id` · `GET /businesses/:id/dashboard` · `GET /businesses/:id/trend` |

---

## 10. Evaluación de la IA

60 reseñas etiquetadas a mano (`samples/evaluacion_sentimiento.csv`) con casos difíciles; se evalúa solo el
texto (sin estrellas). Detalle completo en `docs/EVALUACION.md` (`npm run eval -- --guardar`).

| Motor | Exactitud | F1 macro | Sarcasmo | Jerga colombiana | Negaciones |
|---|---|---|---|---|---|
| Léxico local | 66,7 % | 0,664 | 0 / 7 | 5 / 8 | 7 / 10 |
| Gemini (`gemini-3.5-flash`) | **93,3 %** | **0,928** | **7 / 7** | **8 / 8** | **10 / 10** |

**Costo medido:** un análisis de 44 reseñas con Gemini hace 4 llamadas y consume ≈ 5 200 tokens de entrada y
≈ 6 000 de salida (incluido el razonamiento); en el plan gratuito, $0.

---

## 11. Estado del avance y próximos pasos

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

**Avance 3 (2 nov)**
- [x] **IA real con Gemini (plan gratuito):** nuevo adaptador `GeminiReviewAnalyzer`. El SDK reintenta con espera
  exponencial ante 429/503 y, si el modelo principal sigue saturado, se usa el modelo de respaldo.
- [x] Refactor con **Template Method**: `LlmReviewAnalyzer` concentra la lógica común de los proveedores LLM.
- [x] Probado contra la API real: 44 reseñas analizadas en ~50 s; la reseña con *prompt injection* no alteró el resultado.

**Avance 4 (2 nov)**
- [x] **Cola persistente en PostgreSQL** con `FOR UPDATE SKIP LOCKED`, reintentos con espera y recuperación
  tras reinicios (reemplaza la cola en memoria; no requiere Redis).
- [x] **Seguridad de cuentas:** bloqueo tras intentos fallidos, límite por IP + correo, cambio de contraseña que
  cierra las demás sesiones, eliminación de la cuenta (Habeas Data) y ID de petición en logs y errores.
- [x] **Funciones nuevas:** editar/eliminar negocios, eliminar reseñas, ordenar y filtrar por estrellas,
  tendencia mensual, consumo de IA por análisis, segundo negocio de ejemplo.
- [x] **Evaluación de exactitud** (sección 10) y **contrato OpenAPI**.
- [x] **Calidad:** Biome, CI en ambos repositorios, pruebas contra PostgreSQL real, pruebas unitarias del
  frontend y end-to-end con Playwright, 0 vulnerabilidades en `npm audit`.
- [x] **Frontend:** notificaciones y diálogo accesibles, página Mi cuenta, 404 y ErrorBoundary, carga diferida,
  navegación accesible, plantilla CSV, guía de contraseña y manifiesto web.

**Siguientes pasos posibles**
1. Ampliar el conjunto de evaluación (≈ 200 reseñas) y medir también la detección de temas.
2. Notificar al dueño por correo cuando un análisis termina o cuando una queja crece.
3. Importar reseñas directamente desde Google Business Profile (API oficial).
