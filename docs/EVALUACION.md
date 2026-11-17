# Evaluación del análisis de sentimiento

Conjunto: `samples/evaluacion_sentimiento.csv` (60 reseñas etiquetadas a mano).
Modo: solo texto (sin estrellas). Generado con `npm run eval -- --guardar`.

## Resumen

| Motor | Exactitud | F1 macro |
|---|---|---|
| Léxico local | 66.7 % | 0.664 |
| Gemini (gemini-flash-lite-latest) | 91.7 % | 0.911 |

## Exactitud por tipo de caso

| Tipo | Léxico local | Gemini (gemini-flash-lite-latest) |
|---|---|---|
| descriptiva | 6/6 | 6/6 |
| directo | 12/14 | 14/14 |
| jerga | 5/8 | 7/8 |
| mixta | 5/9 | 5/9 |
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

## Gemini (gemini-flash-lite-latest): métricas por clase

| Clase | Precisión | Cobertura | F1 | Casos |
|---|---|---|---|---|
| positive | 0.950 | 0.905 | 0.927 | 21 |
| neutral | 0.778 | 0.933 | 0.848 | 15 |
| negative | 1.000 | 0.917 | 0.957 | 24 |

Matriz de confusión (filas = esperado, columnas = predicho):

| | positive | neutral | negative | sin respuesta |
|---|---|---|---|---|
| **positive** | 19 | 2 | 0 | 0 |
| **neutral** | 1 | 14 | 0 | 0 |
| **negative** | 0 | 2 | 22 | 0 |

## Elección del modelo

| Modelo | Exactitud | Sarcasmo | Notas |
|---|---|---|---|
| `gemini-flash-lite-latest` (en uso) | 91,7 % y 93,3 % en dos corridas | 7 / 7 | ~25 s por análisis completo; cuota gratuita mayor |
| `gemini-3.5-flash` (respaldo) | 93,3 % | 7 / 7 | En el plan gratuito solo 20 llamadas al día por proyecto (≈ 5 análisis) |

Un modelo de lenguaje no responde idéntico en cada corrida: la diferencia entre 91,7 % y 93,3 % es una reseña de 60.
Ambos superan por ~25 puntos al léxico local y aciertan todos los casos de sarcasmo.

