# Чек-лист деплоя и проверки

## ✅ Шаг 1: Фиксация кода и деплой

### На VPS:

```bash
cd /opt/outlivion-api
git status
git log -1 --oneline
```

**Ожидаемый результат:**
- `git status` → `working tree clean` (нет незакоммиченных правок)
- Последний коммит содержит: "Add payment_subject and payment_mode to receipt" или похожий

**Если status не clean:**
```bash
git add -A
git commit -m "Fix: ..."
git push
sudo systemctl restart outlivion-api
```

---

## ✅ Шаг 2: Проверка работоспособности сервиса

```bash
sudo systemctl status outlivion-api --no-pager
curl -s https://api.outlivion.space/health
echo
```

**Ожидаемый результат:**
- Статус: `active (running)`
- Health check: `{"ok":true,"ts":"..."}`

**Если не работает:**
```bash
sudo journalctl -u outlivion-api -n 50 --no-pager
```

---

## ✅ Шаг 3: Настройка webhook в ЛК YooKassa

### Инструкция:

1. Войдите в личный кабинет YooKassa: https://yookassa.ru/my
2. Перейдите в **Настройки** → **HTTP-уведомления** (или **Webhooks**)
3. Нажмите **Добавить URL** или **Настроить**

### Параметры:

- **URL:** `https://api.outlivion.space/v1/payments/webhook`
- **События (минимум):**
  - ✅ `payment.succeeded` — успешная оплата
  - ✅ `payment.canceled` — отмена платежа

### Проверка:

После сохранения YooKassa отправит тестовое уведомление. Проверьте логи:

```bash
sudo journalctl -u outlivion-api -f
```

**Ожидаемо:** В логах появится запись о получении webhook.

---

## ✅ Шаг 4: Реальный тест платежа

### Создание заказа:

```bash
curl -s -X POST https://api.outlivion.space/v1/orders/create \
  -H "Content-Type: application/json" \
  -d '{"planId":"month","userRef":"test-user"}' | jq .
```

**Ожидаемый результат:**
```json
{
  "orderId": "uuid-...",
  "status": "pending",
  "paymentUrl": "https://yoomoney.ru/checkout/payments/v2/contract?orderId=..."
}
```

### Оплата:

1. Откройте `paymentUrl` в браузере
2. Выполните тестовый/реальный платеж (в зависимости от настроек YooKassa)
3. После оплаты YooKassa вернет вас на `YOOKASSA_RETURN_URL`

---

## ✅ Шаг 5: Проверка обработки webhook

### Проверка статуса заказа:

```bash
ORDER_ID="ваш-order-id-из-шага-4"
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

### Если статус все еще `pending`:

1. Проверьте логи:
```bash
sudo journalctl -u outlivion-api -n 200 --no-pager | grep -i webhook
```

2. Проверьте, что webhook настроен в ЛК YooKassa
3. Проверьте доступность URL извне:
```bash
curl -I https://api.outlivion.space/v1/payments/webhook
```

---

## ✅ Шаг 6: Интеграция фронтенда

См. файл `FRONTEND_INTEGRATION.md` для подробных инструкций.

### Кратко:

1. **Создание заказа:** `POST /v1/orders/create` → редирект на `paymentUrl`
2. **Страница возврата:** Polling `GET /v1/orders/:orderId` каждые 2 сек до `paid`
3. **Отображение ключа:** Показать `key` после подтверждения оплаты

---

## ✅ Шаг 7: Замена DUMMY_KEY на реальный Marzban

**⚠️ ВАЖНО:** Выполнять только после стабильной работы шагов 3-6.

### Задачи:

1. Реализовать реальный вызов Marzban API в `src/integrations/marzban/client.ts`
2. Убедиться в идемпотентности (ключ выдается строго один раз)
3. Сохранить ключ в SQLite

### Текущее состояние:

- Заглушка: `DUMMY_KEY_{orderId}`
- Место для реализации: `src/integrations/marzban/client.ts`

---

## ✅ Шаг 8: Очистка Git от БД

### Локально (уже сделано):

```bash
# .gitignore обновлен
git add .gitignore
git commit -m "Add data/ and SQLite files to .gitignore"
git push
```

### На VPS:

```bash
cd /opt/outlivion-api
git pull

# Если data/db.sqlite был в git (проверить):
git rm --cached data/db.sqlite 2>/dev/null || echo "File not tracked"

# Проверка:
git status
```

**Ожидаемый результат:** `data/db.sqlite` не отображается в `git status` (игнорируется).

---

## 📋 Итоговый чек-лист

- [ ] Код зафиксирован и запушен
- [ ] Сервис работает (`systemctl status` → `active`)
- [ ] Health check возвращает 200 OK
- [ ] Webhook настроен в ЛК YooKassa
- [ ] Реальный платеж протестирован
- [ ] Webhook обрабатывается (заказ становится `paid`)
- [ ] Фронтенд интегрирован (или готов к интеграции)
- [ ] `data/db.sqlite` исключен из Git
- [ ] (Позже) Marzban интегрирован

---

## 🔍 Полезные команды для отладки

```bash
# Логи сервиса
sudo journalctl -u outlivion-api -f

# Последние 100 строк логов
sudo journalctl -u outlivion-api -n 100 --no-pager

# Проверка БД (если установлен sqlite3)
cd /opt/outlivion-api
node -e "const db = require('better-sqlite3')('data/db.sqlite'); console.log(JSON.stringify(db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 5').all(), null, 2));"

# Проверка доступности API
curl -v https://api.outlivion.space/health

# Проверка webhook endpoint
curl -X POST https://api.outlivion.space/v1/payments/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"notification","event":"payment.succeeded","object":{"id":"test","status":"succeeded","paid":true,"metadata":{"orderId":"test"}}}'
```

