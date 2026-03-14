# Quini 6 Results & Ticket Checker

Sistema automatizado para **obtener resultados del Quini 6, procesarlos, validar tickets de usuarios y notificar si ganaron**.

El proyecto utiliza **Node.js** (Express + node-cron) para el backend y la automatización, **PostgreSQL** para almacenar datos y **Telegram** como canal principal de comunicación con los usuarios.

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

```
Backend (Node.js + Express)
│
├── Cron (node-cron): mié/dom 21:15–21:55 cada 5 min → fetch + parse + guardar + validar + notificar
├── Cron 22:00 → alerta al admin si no se obtuvo el resultado
├── Cron mar/sáb 20:00 → recordatorio "mañana es sorteo"
│
▼
PostgreSQL
│
▼
Bot de Telegram (comandos + notificaciones)
```


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
reminder_enabled
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

## quini_results

Resultados de cada sorteo.

id
contest_number
draw_date
result_json
created_at

## ticket_results

Resultado de cada ticket contra cada sorteo.

id
ticket_id
contest_number
draw_date
won_any_prize
results_json
created_at


# ⚙️ Automatización (cron en el backend)

El backend usa **node-cron** para ejecutar el ciclo completo en miércoles y domingos:

1. **21:15 a 21:55** (cada 5 min): intenta obtener el resultado del sitio, parsea el HTML, guarda en DB, valida todos los tickets activos y notifica por Telegram a los ganadores. Si el sorteo ya estaba guardado, no hace nada.
2. **22:00**: si hasta ese momento no se pudo obtener el resultado del día, envía una alerta al admin por Telegram.
3. **Martes y sábado 20:00**: envía recordatorio a los usuarios que lo tienen activado: "Mañana es sorteo a las 21:15 hs".

Cada ticket se compara contra: Tradicional, La Segunda, Revancha, Siempre Sale y Pozo Extra.

Ejecución manual (admin o API): `POST /api/run-cycle` o comando `/runcycle` en Telegram.

---

# 🤖 Telegram Bot

Telegram es la interfaz para los usuarios. Para registrarse hace falta un **código de invitación** (`/start CODIGO`).

**Comandos de usuario**

| Comando | Descripción |
|--------|-------------|
| `/start CODIGO` | Registrarse con el código de invitación |
| `/add 09,11,12,14,18,20` | Agregar un ticket (límite configurable por usuario) |
| `/tickets` | Ver mis tickets |
| `/delete 3` | Eliminar el ticket N° 3 |
| `/resultado` o `/check` | ¿Cómo me fue en el último sorteo? |
| `/ultimo` | Ver el último sorteo guardado con premios |
| `/historial` | Lista de los últimos sorteos guardados |
| `/sorteo 11/03/2026` o `/sorteo 3355` | Buscar un sorteo por fecha o número |
| `/recordar` | Activar/desactivar recordatorio antes del sorteo |
| `/help` | Ayuda |

**Comandos admin** (solo si está configurado `ADMIN_TELEGRAM_ID`)

| Comando | Descripción |
|--------|-------------|
| `/runcycle` | Forzar ciclo completo (fetch + validar + notificar) |
| `/status` | Estado del sistema (usuarios, tickets, último sorteo) |
| `/broadcast mensaje` | Enviar un mensaje a todos los usuarios |

---

# 🔄 Flujo completo del sistema

Cron (miércoles y domingo, 21:15–21:55 cada 5 min)
        │
Fetch Quini Results → Parse HTML → Save Draw Result
        │
Load Active Tickets → Check Each Ticket → Save Ticket Results
        │
Notify Winners (Telegram)
        │
22:00 → Si no se obtuvo resultado: alerta al admin

---

# 🚂 Despliegue en Railway

El proyecto está preparado para desplegarse en [Railway](https://railway.app) con deploy automático desde este repositorio.

## Requisitos

- Cuenta en Railway (plan con PostgreSQL).
- Repositorio en GitHub/GitLab conectado a Railway.

## Pasos

1. **Crear un proyecto en Railway** y conectar este repositorio (Deploy from GitHub repo).

2. **Añadir PostgreSQL** al proyecto: en el dashboard, *New* → *Database* → *PostgreSQL*.

3. **Enlazar PostgreSQL al backend** (importante): el backend necesita `DATABASE_URL`. En el servicio de tu app (backend):
   - Entrá a **Variables** (o **Settings** → **Variables**).
   - Clic en **"+ New Variable"** o **"Add Reference"** / **"Reference Variable"**.
   - Elegí **referenciar el servicio PostgreSQL** y la variable `DATABASE_URL`. Así Railway inyecta la URL real de la base (no localhost).
   - Si no usás referencias: en el servicio PostgreSQL, en **Connect** o **Variables**, copiá el valor de `DATABASE_URL` y crealo como variable en el servicio del backend.

4. **Configurar el servicio del backend**:
   - **Root Directory**: dejar vacío (el build usa la raíz).
   - **Builder**: Railway detecta el `Dockerfile` en la raíz del repo y construye con Docker. El `railway.toml` opcional refuerza el uso de Dockerfile.
   - **Variables de entorno** (Settings → Variables):

   | Variable | Descripción |
   |----------|-------------|
   | `DATABASE_URL` | Inyectada por Railway al enlazar PostgreSQL (no hace falta crearla a mano). |
   | `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram (obligatorio para el bot). |
   | `ADMIN_TELEGRAM_ID` | ID de Telegram del admin (comandos `/runcycle`, `/status`, `/broadcast`). |
   | `INVITE_CODE` | Código para registrarse con `/start CODIGO`. |
   | `MAX_TICKETS_PER_USER` | (Opcional) Límite de tickets por usuario; por defecto 10. |
   | `PORT` | Lo asigna Railway; no suele hacer falta definirlo. |

5. **Schema de la base de datos**: en el primer arranque, si la tabla `users` no existe, el backend ejecuta automáticamente el contenido de `backend/src/db/schema.sql`. No hace falta correr migraciones a mano.

6. **Deploy**: cada push a la rama conectada (por ejemplo `main`) dispara un nuevo build y deploy. Los logs se ven en el panel de Railway.

## Archivos de configuración

- **`railway.toml`**: (opcional) builder Dockerfile, política de reinicio.
- **`Dockerfile`**: en la raíz; construye desde `backend/` e inicia con `node src/index.js`. Es el que Railway/Nixpacks detectan por defecto.

---

# 🛠 Tecnologías utilizadas

- **Node.js** (Express) — API, parser HTML y lógica de validación
- **node-cron** — automatización (sorteos y recordatorios)
- **PostgreSQL** — almacenamiento de resultados, usuarios y tickets
- **Telegram Bot API** — comunicación con usuarios