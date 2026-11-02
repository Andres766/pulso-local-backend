# Evaluación del análisis de sentimiento

Conjunto: `samples/evaluacion_sentimiento.csv` (60 reseñas etiquetadas a mano).
Modo: solo texto (sin estrellas). Generado con `npm run eval -- --guardar`.

## Resumen

| Motor | Exactitud | F1 macro |
|---|---|---|
| Léxico local | 66.7 % | 0.664 |
| Gemini (gemini-3.5-flash) | 93.3 % | 0.928 |

## Exactitud por tipo de caso

| Tipo | Léxico local | Gemini (gemini-3.5-flash) |
|---|---|---|
| descriptiva | 6/6 | 6/6 |
| directo | 12/14 | 13/14 |
| jerga | 5/8 | 8/8 |
| mixta | 5/9 | 6/9 |
| negacion | 7/10 | 10/10 |
| ortografia | 5/6 | 6/6 |
| sarcasmo | 0/7 | 7/7 |

## Léxico local: métricas por clase

| Clase | Precisión | Cobertura | F1 | Casos |
|---|---|---|---|---|
| positive | 0.682 | 0.714 | 0.698 | 21 |
| neutral | 0.500 | 0.733 | 0.595 | 15 |
| negative | 0.875 | 0.583 | 0.700 | 24 |

Matriz de confusión (filas = esperado, columnas = predicho):

| | positive | neutral | negative | sin respuesta |
|---|---|---|---|---|
| **positive** | 15 | 6 | 0 | 0 |
| **neutral** | 2 | 11 | 2 | 0 |
| **negative** | 5 | 5 | 14 | 0 |

## Gemini (gemini-3.5-flash): métricas por clase

| Clase | Precisión | Cobertura | F1 | Casos |
|---|---|---|---|---|
| positive | 0.952 | 0.952 | 0.952 | 21 |
| neutral | 0.824 | 0.933 | 0.875 | 15 |
| negative | 1.000 | 0.917 | 0.957 | 24 |

Matriz de confusión (filas = esperado, columnas = predicho):

| | positive | neutral | negative | sin respuesta |
|---|---|---|---|---|
| **positive** | 20 | 1 | 0 | 0 |
| **neutral** | 1 | 14 | 0 | 0 |
| **negative** | 0 | 2 | 22 | 0 |
