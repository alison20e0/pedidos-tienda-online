# pedidos-tienda-online

Ejercicio de Arquitectura de Sistemas: API de pedidos con **reserva de inventario**, **idempotencia**,
**historial de estados** y **eventos en RabbitMQ**. Node.js 20 + Express + PostgreSQL (`pg`) + `amqplib`.

## Como levantar

Requisitos: Docker y Docker Compose.

```bash
cp .env.example .env        # en PowerShell: Copy-Item .env.example .env
docker compose up -d --build
docker compose ps           # esperar a que api, postgres y rabbitmq estén healthy
```

`docker compose up -d --build` no devuelve hasta que PostgreSQL y RabbitMQ están healthy, así que la API
nunca arranca a ciegas; el primer arranque puede tardar un par de minutos (RabbitMQ es el más lento).

La primera vez PostgreSQL crea el esquema y carga los 3 productos de ejemplo desde `scripts/sql/`
(montados en `/docker-entrypoint-initdb.d`). La API también ejecuta esos mismos scripts al arrancar,
de forma idempotente, para recuperarse si el volumen ya existía.

Parar y borrar los datos:

```bash
docker compose down -v
```

## Puertos

| Servicio   | Host    | Contenedor | Uso                                     |
| ---------- | ------- | ---------- | --------------------------------------- |
| API        | `3000`  | `3000`     | REST + interfaz web en `/`              |
| PostgreSQL | `5444`  | `5432`     | `psql postgresql://admin:secretpassword123@localhost:5444/pedidos_db` |
| RabbitMQ   | `5674`  | `5672`     | AMQP                                    |
| RabbitMQ   | `15674` | `15672`    | Consola web: http://localhost:15674     |

Los puertos del contenedor son los estándar (5432/5672); en el host se desplazan para no chocar con
instalaciones locales.

## Credenciales

Todo viene de variables de entorno (plantilla en `.env.example`, valores reales en `.env`, que está en
`.gitignore`). `docker compose` sustituye `${DB_USER:-admin}` etc. usando `.env` si existe.

## Endpoints

| Método | Ruta                     | Descripción                                                  |
| ------ | ------------------------ | ------------------------------------------------------------ |
| GET    | `/health`                | Estado de la API, PostgreSQL y RabbitMQ (healthcheck Docker) |
| POST   | `/pedidos`               | Crea el pedido; **requiere `Idempotency-Key`**               |
| GET    | `/pedidos/:id`           | Pedido con sus items                                        |
| GET    | `/pedidos/:id/estado`    | Estado actual + historial de `evento_pedido` + pagos        |
| POST   | `/pedidos/:id/preparar`  | `PAGADO` → `EN_PREPARACION`                                 |
| POST   | `/pedidos/:id/despachar` | `EN_PREPARACION` → `DESPACHADO`                             |
| POST   | `/webhooks/pago`         | Pago del proveedor; idempotente por `referencia`            |

### Los 5 comandos curl del flujo completo

```bash
# 1) Crear el pedido (id 1, 2 unidades del producto 1). Sale 201 y queda RESERVADO.
curl -s -X POST http://localhost:3000/pedidos \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pedido-demo-001' \
  -d '{"cliente":"Alison","items":[{"producto_id":1,"cantidad":2}]}'

# 2) Repetir la MISMA clave: devuelve 200 y el mismo pedido, sin duplicar ni reservar otra vez.
curl -s -X POST http://localhost:3000/pedidos \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pedido-demo-001' \
  -d '{"cliente":"Alison","items":[{"producto_id":1,"cantidad":2}]}'

# 3) Webhook de pago aprobado (idempotente por referencia): RESERVADO → PAGADO.
curl -s -X POST http://localhost:3000/webhooks/pago \
  -H 'Content-Type: application/json' \
  -d '{"referencia":"pago-demo-001","pedido_id":1,"estado":"aprobado","monto":159.80}'

# 4) Consultar estado e historial del pedido.
curl -s http://localhost:3000/pedidos/1/estado

# 5) Preparar y despachar: publica el evento PedidoDespachado en RabbitMQ.
curl -s -X POST http://localhost:3000/pedidos/1/preparar
curl -s -X POST http://localhost:3000/pedidos/1/despachar
```

> **En PowerShell** el `curl` de Windows elimina las comillas del JSON: escápalas con barra invertida.
> ```powershell
> curl.exe -s -X POST http://localhost:3000/pedidos `
>   -H "Content-Type: application/json" `
>   -H "Idempotency-Key: pedido-demo-001" `
>   -d '{\"cliente\":\"Alison\",\"items\":[{\"producto_id\":1,\"cantidad\":2}]}'
> ```
> Los cinco comandos de arriba tal cual son para bash (Linux, macOS, WSL, Git Bash y el devcontainer).

## Flujo de estados

```
CONFIRMADO ──reserva ok──▶ RESERVADO ──pago aprobado──▶ PAGADO ──preparar──▶ EN_PREPARACION ──despachar──▶ DESPACHADO
     │                          │                           │
     │stock insuficiente        │pago rechazado             └──▶ (publica PedidoPagado)
     ▼                          ▼
  CANCELADO  ◀──venció la reserva (15 min) o pago rechazado (libera la reserva)
     │
     └──pago aprobado tardío: se renueva la reserva──▶ PAGADO | si no hay stock ──▶ EN_REVISION (pago ANULADO)
```

- **Idempotencia de creación**: `pedido.idempotency_key` es `UNIQUE`. Repetir la clave devuelve el pedido
  original (200) en lugar de crear otro.
- **Reserva atómica**: `UPDATE producto SET reservado = reservado + $2 WHERE id = $1 AND stock - reservado >= $2`.
  Los productos se bloquean ordenados por id (`FOR UPDATE`), así que una reserva es todo-o-nada y no hay
  *deadlocks*. La reserva expira a los 15 minutos (`RESERVA_TTL_MINUTOS`); el barrido en memoria libera el
  stock y cancela el pedido.
- **Sin stock al crear**: el pedido se registra igualmente en `CANCELADO` con el motivo en el historial
  (respuesta 201). Así la clave de idempotencia no se queda consumida a medias y el intento queda auditable.
- **Regla crítica**: si el pago se aprueba cuando la reserva ya venció, se intenta **renovar** la reserva.
  - Si se renueva → `PAGADO` (evento `PedidoPagado`).
  - Si **no** hay stock para renovarla → el pago se guarda como `ANULADO` y el pedido pasa a `EN_REVISION`,
    con el motivo en el historial. Nunca queda un pedido cobrado sin stock, ni un estado ambiguo.
- **Historial**: cada cambio de estado inserta una fila en `evento_pedido` (tipo, estado anterior, estado
  nuevo, detalle, si se publicó en el bus).

## RabbitMQ

- Exchange `pedidos.eventos` (topic, durable) y cola `notificaciones.cliente` (durable).
- La API publica `PedidoPagado` y `PedidoDespachado` con confirmación del broker
  (canal *confirm*); `evento_pedido.publicado_en` queda con la hora de publicación.
- El consumidor de la propia API simula la notificación al cliente (log en `docker compose logs -f api`):
  ```
  [INFO] [notificaciones] Enviando confirmacion de pago a Alison por el pedido 1 (159.8)
  ```
- Si el broker no responde, la API sigue funcionando, se reconecta sola y `/health` devuelve `degradado`.

## Esquema

`scripts/sql/01-esquema.sql`

| Tabla          | Notas                                                                    |
| -------------- | ------------------------------------------------------------------------ |
| `producto`     | `stock`, `reservado`, `CHECK (stock >= 0)`, `CHECK (reservado <= stock)`  |
| `pedido`       | `idempotency_key UNIQUE`, `estado`, `reserva_expira_en`, `total`          |
| `pedido_item`  | Items con `precio_unitario` congelado y `subtotal` generado              |
| `pago`         | `referencia UNIQUE` (idempotencia del webhook), `estado` APROBADO/RECHAZADO/ANULADO |
| `evento_pedido` | Historial de estados, con `publicable` y `publicado_en`                  |

`scripts/sql/02-datos-ejemplo.sql` carga 3 productos: Auriculares inalámbricos (79.90, stock 10),
Mochila urbana 25L (119.50, stock 8), Lámpara de escritorio LED (34.00, stock 15).

## Estructura

```
src/
  server.js      arranque: aplica el esquema, conecta a RabbitMQ, levanta Express y el barrido
  app.js         rutas, healthcheck e interfaz web
  pedidos.js     reglas de negocio (pedidos, pago, transiciones, barrido de reservas)
  inventario.js  reserva/release/confirmación de stock (SQL atómico)
  eventos.js     historial en evento_pedido + publicación en RabbitMQ
  rabbit.js      exchange, cola, publicador y consumidor de notificaciones
  db.js          pool de pg, transacciones y aplicación de scripts SQL
  config.js      configuración por variables de entorno
public/index.html  interfaz web: id del pedido -> estado + historial
scripts/sql/       esquema y datos de ejemplo
```

## Interfaz web

`http://localhost:3000` — se escribe el id del pedido y se ven su estado, items, pagos y el historial
completo, con refresco automático opcional y botones para preparar/despachar.