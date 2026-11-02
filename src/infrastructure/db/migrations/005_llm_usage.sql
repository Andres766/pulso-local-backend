-- Consumo del modelo de lenguaje por análisis (sumado en todos los intentos): control de costos.
ALTER TABLE analysis_runs
  ADD COLUMN llm_calls     INTEGER NOT NULL DEFAULT 0 CHECK (llm_calls >= 0),
  ADD COLUMN input_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0);
