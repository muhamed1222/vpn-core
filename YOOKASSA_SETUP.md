# Настройка YooKassa Webhook

## Инструкция для личного кабинета YooKassa

### 1. Вход в личный кабинет

1. Перейдите на https://yookassa.ru/my
2. Войдите в свой аккаунт

### 2. Настройка Webhook

1. Перейдите в раздел **"Настройки"** → **"HTTP-уведомления"** (или **"Webhooks"**)
2. Нажмите **"Добавить URL"** или **"Настроить"**

### 3. Параметры Webhook

**URL для уведомлений:**
```
https://api.outlivion.space/v1/payments/webhook
```

**События для отправки (минимум):**
- ✅ `payment.succeeded` — успешная оплата
- ✅ `payment.canceled` — отмена платежа

**Дополнительные события (опционально):**
- `payment.waiting_for_capture` — ожидает подтверждения
- `refund.succeeded` — успешный возврат

### 4. Проверка HTTPS

Убедитесь, что:
- ✅ Домен `api.outlivion.space` имеет валидный SSL сертификат (Let's Encrypt)
- ✅ Сертификат не истек: `curl -I https://api.outlivion.space/health`
- ✅ YooKassa может достучаться до вашего сервера (проверьте firewall)

### 5. Тестирование Webhook

После настройки YooKassa автоматически отправит тестовое уведомление.

**Проверка в логах:**
```bash
sudo journalctl -u outlivion-api -f
```

**Ожидаемое поведение:**
- Webhook получает уведомление
- В логах появляется запись о обработке
- Если это тестовое уведомление без реального orderId — вернется 200 OK (нормально)

### 6. Проверка IP (опционально)

Если включена проверка IP (`YOOKASSA_WEBHOOK_IP_CHECK=true`), убедитесь, что IP YooKassa разрешены.

**IP адреса YooKassa:**
- `185.71.76.0/27`
- `185.71.77.0/27`
- `77.75.153.0/25`
- `77.75.156.11`
- `77.75.156.35`
- `77.75.154.128/25`
- `2a02:5180::/32` (IPv6)

**Рекомендация:** На начальном этапе оставьте `YOOKASSA_WEBHOOK_IP_CHECK=false` для упрощения отладки.

---

## Чек-лист настройки

- [ ] URL webhook указан: `https://api.outlivion.space/v1/payments/webhook`
- [ ] События выбраны: `payment.succeeded`, `payment.canceled`
- [ ] SSL сертификат валиден
- [ ] Тестовое уведомление получено (проверено в логах)
- [ ] Реальный платеж обрабатывается корректно

---

## Отладка проблем

### Проблема: YooKassa не может достучаться до webhook

**Проверки:**
```bash
# Проверка доступности извне
curl -I https://api.outlivion.space/v1/payments/webhook

# Проверка firewall
sudo ufw status
sudo iptables -L -n | grep 443
```

### Проблема: Webhook получает 403 Forbidden

**Причина:** Включена проверка IP, но IP YooKassa не в allowlist.

**Решение:** Временно отключите проверку IP:
```bash
# В .env
YOOKASSA_WEBHOOK_IP_CHECK=false
sudo systemctl restart outlivion-api
```

### Проблема: Webhook получает 400 Bad Request

**Причина:** Неверный формат уведомления или валидация не прошла.

**Проверка:**
```bash
# Логи с деталями ошибки
sudo journalctl -u outlivion-api -n 50 | grep -i webhook
```

**Решение:** Проверьте формат уведомления в документации YooKassa.

---

## Безопасность

⚠️ **Важно:**
- Не логируйте полные тела webhook-запросов (могут содержать чувствительные данные)
- Используйте проверку IP в production (`YOOKASSA_WEBHOOK_IP_CHECK=true`)
- Регулярно проверяйте логи на подозрительную активность
- Храните `YOOKASSA_SECRET_KEY` в безопасности (chmod 600 на .env)

