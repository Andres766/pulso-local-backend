-- Cola de análisis persistente: analysis_runs es a la vez el historial y la cola de trabajos.
-- Un worker toma el siguiente pendiente con FOR UPDATE SKIP LOCKED (ver PgAnalysisRepository.claimNext).

ALTER TABLE analysis_runs
  ADD COLUMN attempts     SMALLINT    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN available_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Índice parcial: solo indexa lo que el worker busca (pendientes listos para correr).
CREATE INDEX idx_runs_queue ON analysis_runs (available_at, created_at) WHERE status = 'pending';
