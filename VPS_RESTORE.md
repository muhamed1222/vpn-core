# Восстановление сервиса на VPS

## Шаг 1: Установка build-инструментов

Выполните на VPS:

```bash
# Обновление пакетов
sudo apt update

# Установка инструментов сборки для better-sqlite3
sudo apt install -y make build-essential python3 pkg-config libsqlite3-dev

# Проверка установки
which make
which python3
pkg-config --version
```

**Ожидаемый результат:** Все команды должны вернуть версии/пути без ошибок.

---

## Шаг 2: Создание директории для БД

```bash
# Создаем директорию для базы данных
sudo mkdir -p /opt/outlivion-api/data

# Устанавливаем владельца (если пользователь outlivion уже создан)
sudo chown outlivion:outlivion /opt/outlivion-api/data

# Устанавливаем права доступа
sudo chmod 755 /opt/outlivion-api/data

# Проверка
ls -la /opt/outlivion-api/ | grep data
```

**Ожидаемый результат:** Директория `/opt/outlivion-api/data` существует с правами `drwxr-xr-x` и владельцем `outlivion:outlivion`.

---

## Шаг 3: Проверка и обновление .env

```bash
cd /opt/outlivion-api

# Проверяем текущий .env
cat .env | grep -v SECRET_KEY | grep -v SHOP_ID

# Если нужно обновить, редактируем
sudo nano .env
```

**Минимальный набор переменных в .env:**

```env
HOST=127.0.0.1
PORT=3001
DATABASE_PATH=/opt/outlivion-api/data/db.sqlite
ALLOWED_ORIGINS=https://outlivion.space,https://www.outlivion.space,https://my.outlivion.space
YOOKASSA_SHOP_ID=1238454
YOOKASSA_SECRET_KEY=live_TxXPufJGkS0WGH46uK8MbAg1D0yNJsIT58m6t9Fo4aQ
YOOKASSA_RETURN_URL=https://my.outlivion.space/pay/return
YOOKASSA_WEBHOOK_IP_CHECK=false
PUBLIC_BASE_URL=https://api.outlivion.space
```

**Проверка прав доступа:**
```bash
ls -la /opt/outlivion-api/.env
# Должно быть: -rw------- (600) outlivion:outlivion
```

---

## Шаг 4: Пересборка проекта

```bash
cd /opt/outlivion-api

# Очистка старых зависимостей (опционально, если были проблемы)
# sudo rm -rf node_modules package-lock.json

# Установка зависимостей (production + dev для сборки)
sudo -u outlivion npm ci

# Сборка TypeScript
sudo -u outlivion npm run build

# Проверка сборки
ls -la dist/server.js
```

**Ожидаемый результат:**
- `npm ci` завершается без ошибок
- `npm run build` завершается без ошибок
- Файл `dist/server.js` существует

---

## Шаг 5: Перезапуск сервиса

```bash
# Перезапуск systemd сервиса
sudo systemctl restart outlivion-api

# Проверка статуса
sudo systemctl status outlivion-api --no-pager

# Просмотр логов (если статус не active)
sudo journalctl -u outlivion-api -n 50 --no-pager
```

**Ожидаемый результат:**
- Статус: `active (running)`
- В логах нет ошибок типа "Database not initialized" или "Cannot find module"

---

## Шаг 6: Проверка работоспособности

### 6.1 Локальная проверка (на VPS)

```bash
# Health check
curl -s http://127.0.0.1:3001/health && echo

# Root endpoint
curl -s http://127.0.0.1:3001/ && echo
```

**Ожидаемый результат:**
- `/health` → `{"ok":true,"ts":"..."}`
- `/` → `{"ok":true,"service":"outlivion-api"}`

### 6.2 Публичная проверка (через домен)

```bash
# Health check через домен
curl -s https://api.outlivion.space/health && echo

# Root endpoint
curl -i https://api.outlivion.space/ | head -10
```

**Ожидаемый результат:**
- HTTP 200 OK
- Корректный JSON ответ
- SSL сертификат валиден

---

## Шаг 7: Тестирование API (после восстановления)

### 7.1 Создание заказа

```bash
# Создаем заказ
RESPONSE=$(curl -s -X POST https://api.outlivion.space/v1/orders/create \
  -H "Content-Type: application/json" \
  -d '{"planId":"month","userRef":"test-user"}')

echo "$RESPONSE" | jq .

# Извлекаем orderId
ORDER_ID=$(echo "$RESPONSE" | jq -r '.orderId')
echo "Order ID: $ORDER_ID"
```

**Ожидаемый результат:**
```json
{
  "orderId": "uuid-...",
  "status": "pending",
  "paymentUrl": "https://yoomoney.ru/checkout/payments/v2/contract?orderId=..."
}
```

**Важно:** `paymentUrl` должен быть реальным URL YooKassa (не `example.com`).

### 7.2 Проверка заказа

```bash
# Проверяем статус заказа
curl -s https://api.outlivion.space/v1/orders/$ORDER_ID | jq .
```

**Ожидаемый результат:**
```json
{
  "orderId": "...",
  "status": "pending"
}
```

### 7.3 Симуляция webhook (до подключения в ЛК YooKassa)

```bash
# Симулируем успешный платеж
PAYMENT_ID="pay_test_$(date +%s)"

curl -s -X POST https://api.outlivion.space/v1/payments/webhook \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"notification\",
    \"event\": \"payment.succeeded\",
    \"object\": {
      \"id\": \"$PAYMENT_ID\",
      \"status\": \"succeeded\",
      \"paid\": true,
      \"amount\": {
        \"value\": \"299.00\",
        \"currency\": \"RUB\"
      },
      \"metadata\": {
        \"orderId\": \"$ORDER_ID\",
        \"userRef\": \"test-user\",
        \"planId\": \"month\"
      }
    }
  }" | jq .
```

**Ожидаемый результат:**
- HTTP 200 OK
- `{"ok":true}`
- В логах: `Order marked as paid with key`

### 7.4 Проверка заказа после webhook

```bash
# Проверяем, что заказ стал paid и появился key
curl -s https://api.outlivion.space/v1/orders/$ORDER_ID | jq .
```

**Ожидаемый результат:**
```json
{
  "orderId": "...",
  "status": "paid",
  "key": "DUMMY_KEY_..."
}
```

### 7.5 Проверка идемпотентности

```bash
# Повторно отправляем тот же webhook
curl -s -X POST https://api.outlivion.space/v1/payments/webhook \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"notification\",
    \"event\": \"payment.succeeded\",
    \"object\": {
      \"id\": \"$PAYMENT_ID\",
      \"status\": \"succeeded\",
      \"paid\": true,
      \"metadata\": {
        \"orderId\": \"$ORDER_ID\"
      }
    }
  }" | jq .

# Проверяем, что key не изменился
curl -s https://api.outlivion.space/v1/orders/$ORDER_ID | jq .
```

**Ожидаемый результат:**
- Webhook возвращает 200 OK
- В логах: `Order already paid, skipping`
- Key остался прежним (не создался второй раз)

---

## Если что-то пошло не так

### Проблема: Сервис не запускается

```bash
# Детальные логи
sudo journalctl -u outlivion-api -n 120 --no-pager

# Проверка прав доступа
ls -la /opt/outlivion-api/dist/server.js
ls -la /opt/outlivion-api/data/

# Проверка переменных окружения
sudo systemctl show outlivion-api | grep Environment
```

### Проблема: Ошибка сборки better-sqlite3

```bash
# Проверка установленных инструментов
which make
which python3
pkg-config --version

# Переустановка зависимостей
cd /opt/outlivion-api
sudo rm -rf node_modules
sudo -u outlivion npm ci
```

### Проблема: База данных не создается

```bash
# Проверка прав на директорию
ls -la /opt/outlivion-api/data

# Проверка переменной DATABASE_PATH
grep DATABASE_PATH /opt/outlivion-api/.env

# Ручное создание БД (для теста)
sudo -u outlivion sqlite3 /opt/outlivion-api/data/db.sqlite "SELECT 1;"
```

---

## Чек-лист после восстановления

- [ ] Сервис запущен: `systemctl status outlivion-api` → `active (running)`
- [ ] Health check работает: `curl http://127.0.0.1:3001/health` → 200 OK
- [ ] Публичный доступ работает: `curl https://api.outlivion.space/health` → 200 OK
- [ ] База данных создана: `ls -la /opt/outlivion-api/data/db.sqlite` → файл существует
- [ ] Создание заказа работает: возвращает `paymentUrl` от YooKassa
- [ ] Webhook обрабатывается: заказ становится `paid`, создается `key`
- [ ] Идемпотентность работает: повторный webhook не создает второй key

