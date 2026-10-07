-- PulsoLocal · esquema inicial
-- Modelo: usuario 1─N negocio 1─N reseña
--                         negocio 1─N análisis 1─N tema ─N:M─ reseña
--                                          análisis 1─N recomendación

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            UUID PRIMARY KEY,
  email         VARCHAR(254) NOT NULL UNIQUE,
  name          VARCHAR(80)  NOT NULL,
  password_hash TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE businesses (
  id         UUID PRIMARY KEY,
  owner_id   UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(120) NOT NULL,
  category   VARCHAR(30)  NOT NULL
             CHECK (category IN ('restaurante','cafeteria','tienda','belleza','servicios','salud','otro')),
  city       VARCHAR(80),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_businesses_owner ON businesses(owner_id);

CREATE TABLE reviews (
  id           UUID PRIMARY KEY,
  business_id  UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  content      TEXT        NOT NULL CHECK (char_length(content) BETWEEN 3 AND 2000),
  content_hash CHAR(64)    NOT NULL,
  rating       SMALLINT    CHECK (rating BETWEEN 1 AND 5),
  source       VARCHAR(10) NOT NULL CHECK (source IN ('csv','manual')),
  authored_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Deduplicación: la misma reseña no se cuenta dos veces en un negocio.
  CONSTRAINT uq_reviews_business_hash UNIQUE (business_id, content_hash)
);
CREATE INDEX idx_reviews_business_created ON reviews(business_id, created_at DESC);

CREATE TABLE analysis_runs (
  id              UUID PRIMARY KEY,
  business_id     UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status          VARCHAR(12) NOT NULL CHECK (status IN ('pending','running','completed','failed')),
  provider        VARCHAR(80) NOT NULL,
  review_count    INTEGER     NOT NULL CHECK (review_count >= 0),
  positive_count  INTEGER,
  neutral_count   INTEGER,
  negative_count  INTEGER,
  average_score   NUMERIC(4,3),
  error           VARCHAR(500),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);
CREATE INDEX idx_runs_business_created ON analysis_runs(business_id, created_at DESC);

-- Sentimiento que asignó cada análisis a cada reseña (histórico, no se sobrescribe).
CREATE TABLE review_sentiments (
  run_id    UUID        NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  review_id UUID        NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  sentiment VARCHAR(10) NOT NULL CHECK (sentiment IN ('positive','neutral','negative')),
  score     NUMERIC(4,3) NOT NULL CHECK (score BETWEEN -1 AND 1),
  PRIMARY KEY (run_id, review_id)
);
CREATE INDEX idx_review_sentiments_review ON review_sentiments(review_id);

-- Temas detectados (topic modeling) con sus cifras ya calculadas.
CREATE TABLE topics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID         NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  key             VARCHAR(60)  NOT NULL,
  name            VARCHAR(60)  NOT NULL,
  description     VARCHAR(200) NOT NULL,
  mentions        INTEGER      NOT NULL,
  share           NUMERIC(5,1) NOT NULL,
  positive_count  INTEGER      NOT NULL,
  neutral_count   INTEGER      NOT NULL,
  negative_count  INTEGER      NOT NULL,
  complaint_share NUMERIC(5,1) NOT NULL,
  sample_quotes   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT uq_topics_run_key UNIQUE (run_id, key)
);

CREATE TABLE review_topics (
  topic_id  UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, review_id)
);
CREATE INDEX idx_review_topics_review ON review_topics(review_id);

CREATE TABLE recommendations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID         NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  topic_id       UUID         REFERENCES topics(id) ON DELETE SET NULL,
  rank           SMALLINT     NOT NULL,
  title          VARCHAR(120) NOT NULL,
  detail         VARCHAR(800) NOT NULL,
  priority       VARCHAR(5)   NOT NULL CHECK (priority IN ('alta','media','baja')),
  evidence_share NUMERIC(5,1)
);
CREATE INDEX idx_recommendations_run ON recommendations(run_id, rank);
