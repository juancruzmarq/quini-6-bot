# Quini 6 Results & Ticket Checker

Sistema automatizado para **obtener resultados del Quini 6, procesarlos, validar tickets de usuarios y notificar si ganaron**.

El proyecto utiliza **n8n** para orquestar workflows, **PostgreSQL** para almacenar datos y **Telegram** como canal principal de comunicación con los usuarios.

---

# 🚀 Objetivo

Automatizar el proceso de:

1. Obtener el resultado del último sorteo del **Quini 6**
2. Extraer números ganadores y premios
3. Guardar resultados en base de datos
4. Comparar los tickets de usuarios contra el sorteo
5. Detectar si un ticket ganó
6. Notificar al usuario automáticamente

---

# 🧠 Arquitectura del sistema
n8n Workflow
(Fetch + Parse HTML)
│
▼
PostgreSQL Database
│
▼
Ticket Validation Engine
│
▼
Telegram Notifications


---

# 🌐 Fuente de resultados

Los resultados se obtienen desde:
https://www.quini-6-resultados.com.ar/


Desde esa página se extrae:

- Fecha del sorteo
- Número de sorteo
- Números ganadores
- Detalle de ganadores
- Premios por división
- Premio por ganador
- Pozo acumulado

---

# 🎲 Modalidades del Quini 6

Cada sorteo tiene varias modalidades.

## Tradicional
Se gana con:

- 4 aciertos
- 5 aciertos
- 6 aciertos

---

## La Segunda
Se gana con:

- 4 aciertos
- 5 aciertos
- 6 aciertos

---

## Revancha
Se gana únicamente con:

- 6 aciertos

---

## Siempre Sale
Se gana con:

- 5 aciertos

---

## Pozo Extra

El Pozo Extra se calcula usando los números de:

- Tradicional
- Segunda
- Revancha

Se crea la **unión de todos los números sin repetir**.

Un ticket gana el Pozo Extra si **sus 6 números están contenidos dentro de esa unión**.

### Regla importante

Si un ticket ya ganó en:

- Tradicional
- Segunda
- Revancha
- Siempre Sale

entonces **NO participa del Pozo Extra**.

---

# 📦 Estructura del resultado del sorteo

El parser del HTML genera una estructura como esta:

```json
{
  "drawDate": "2026-03-11",
  "drawDateRaw": "11/03/2026",
  "contestNumber": "3355",
  "jackpot": "$4.400.000.000",
  "jackpotAmount": 4400000000,
  "modalities": {
    "tradicional": {
      "numbers": ["09","11","12","14","18","20"],
      "prizes": [
        {
          "hits": "6",
          "winners": 2,
          "prize": "$390000000",
          "prizeAmount": 390000000,
          "prizePerWinner": "$195000000"
        }
      ]
    }
  }
}
```

# 🗄 Base de datos

## users

Usuarios registrados en el sistema.

id
name
telegram_chat_id
telegram_username
is_active
created_at
updated_at

## tickets

Cada usuario puede tener múltiples tickets.

id
user_id
label
numbers_json
is_active
created_at
updated_at

## Ejemplo de números:

["09","11","12","14","18","20"]
quini_results

## Resultados de cada sorteo.

id
contest_number
draw_date
result_json
created_at
ticket_results

## Resultado de cada ticket contra cada sorteo.

id
ticket_id
contest_number
draw_date
won_any_prize
results_json
created_at


# ⚙️ Workflows n8n


## Workflow 1 — Obtener resultado del sorteo

Manual Trigger / Cron
        │
Fetch Quini Page
        │
Parse HTML
        │
Guardar resultado en DB

Este workflow:

descarga el HTML

extrae números y premios

guarda el resultado estructurado

## Workflow 2 — Validar tickets

Load Tickets
        │
Loop Tickets
        │
Check Ticket Against Results
        │
Guardar resultado

Cada ticket se compara contra:

Tradicional

Segunda

Revancha

Siempre Sale

Pozo Extra

## Workflow 3 — Notificación

Si un ticket gana:

Send Telegram Message

Ejemplo de mensaje:

# 🎉 Tu ticket ganó en el Quini 6

Sorteo: 3355
Fecha: 11/03/2026

Modalidad: Tradicional
Aciertos: 6

Premio por ganador:
$195.000.000

Tus números:
09 - 11 - 12 - 14 - 18 - 20

# 🤖 Telegram Bot

Telegram se usa como interfaz para los usuarios.

Registrar usuario
/start

Agregar ticket
/add 09,11,12,14,18,20

Ver tickets
/tickets

Eliminar ticket
/delete 3

# 🔄 Flujo completo del sistema

Cron (miércoles y domingo)
        │
Fetch Quini Results
        │
Parse HTML
        │
Save Draw Result
        │
Load Active Tickets
        │
Check Each Ticket
        │
Save Ticket Results
        │
Notify Winners (Telegram)

# 🛠 Tecnologías utilizadas

n8n → automatización de workflows

Node.js / JavaScript → parsing y lógica de validación

PostgreSQL → almacenamiento de resultados y tickets

Telegram Bot API → comunicación con usuarios