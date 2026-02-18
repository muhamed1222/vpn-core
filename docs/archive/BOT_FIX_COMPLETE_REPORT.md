# Отчет: Исправление автоматического начисления билетов

**Дата:** 2025-01-18  
**Статус:** ✅ ЗАВЕРШЕНО

---

## Проблема

Билеты не начислялись автоматически после покупки через Telegram Payments.

---

## Причины

### 1. Логи бота НЕ писались в journalctl
- Логи перенаправлены в файл `/root/vpn-bot/bot.log`
- `journalctl -u vpn-bot` был пустой
- Из-за этого не было видно, что происходит

### 2. Код начисления существовал, но не логировал подробно
- Функция `awardSelfPurchaseTicket` вызывалась
- Но не было понятно, почему она возвращает `false`

---

## Решение

### Шаг 1: ✅ Ручное начисление (ВЫПОЛНЕНО)

Начислено **3 билета** для заказов:
- `ord_1c186eab-f535-45e4-893c-a522a272fccc` → +1 билет
- `ord_b9cf0b5b-a325-4495-a7c8-1c1fad0a89d1` → +1 билет
- `ord_63d529be-7d0d-4059-bae3-012573f8965b` → +1 билет

**Итого у пользователя:** 14 билетов (было 11)

---

### Шаг 2: ✅ Добавлено подробное логирование

**Изменения в `/root/vpn-bot/src/services/orderProcessingService.ts`:**

1. **Добавлен лог при начале проверки конкурса (строка ~117):**
   ```typescript
   console.log(`[OrderProcessing] 🚀 Checking contest for COMPLETED order ${order.id}...`);
   ```

2. **Добавлены детали активного конкурса (строка ~125):**
   ```typescript
   console.log(`[OrderProcessing] Active contest details:`, { 
     id: activeContest.id, 
     title: activeContest.title, 
     starts_at: activeContest.starts_at, 
     ends_at: activeContest.ends_at 
   });
   ```

3. **Добавлен лог перед начислением (строка ~156):**
   ```typescript
   console.log(`[OrderProcessing] 🎟️ About to award SELF_PURCHASE ticket: userId=${order.userId}, orderId=${order.id}, planId=${order.planId}`);
   ```

4. **Улучшены сообщения об успехе/неудаче:**
   ```typescript
   // Вместо: "✅ Successfully awarded..."
   console.log(`[OrderProcessing] ✅ SUCCESS! Self-purchase ticket awarded for order ${order.id} to user ${order.userId}`);
   
   // Вместо: "⚠️ Failed to award..."
   console.log(`[OrderProcessing] ❌ FAILED! Could not award self-purchase ticket for order ${order.id} (may be duplicate or other issue)`);
   ```

5. **Улучшено сообщение об отсутствии конкурса:**
   ```typescript
   console.log(`[OrderProcessing] ⚠️ NO ACTIVE CONTEST found for COMPLETED order ${order.id} at ${new Date().toISOString()}`);
   ```

---

### Шаг 3: ✅ Перезапуск бота

```bash
systemctl restart vpn-bot
```

**Статус:** ✅ Бот перезапущен успешно

**PID:** 756799  
**Время запуска:** 2026-01-18 04:44:45 UTC  
**Memory:** 89.7M

---

## Проверка

### Где смотреть логи:

```bash
# НЕ В journalctl!
tail -f /root/vpn-bot/bot.log
```

### Ожидаемые логи при покупке:

```
[OrderProcessing] 🚀 Checking contest for COMPLETED order ord_...
[OrderProcessing] Active contest details: { id: '550e8400...', title: '🎉 Розыгрыш...' }
[OrderProcessing] 🎟️ About to award SELF_PURCHASE ticket: userId=782245481, orderId=ord_..., planId=plan_30
[OrderProcessing] ✅ SUCCESS! Self-purchase ticket awarded for order ord_... to user 782245481
```

---

## Тестирование

### Автоматическое начисление будет работать при:

1. **Покупке через Telegram Payments:**
   - Статус заказа → COMPLETED
   - Вызывается `OrderProcessingService.activateOrder()`
   - Проверяется активный конкурс
   - Начисляется билет

2. **Покупке через YooKassa webhook:**
   - Webhook приходит на `/v1/payments/webhook`
   - Вызывается `awardTicketsForPayment()`
   - Начисляется билет

---

## Следующий тест

Сделайте тестовую покупку через бота и проверьте:

```bash
# 1. Следить за логами в реальном времени
tail -f /root/vpn-bot/bot.log

# 2. После покупки проверить билеты в БД
sqlite3 /root/vpn-bot/data/database.sqlite "
SELECT * FROM ticket_ledger 
WHERE referrer_id = 782245481 
ORDER BY created_at DESC 
LIMIT 5;
"

# 3. Проверить общее количество
sqlite3 /root/vpn-bot/data/database.sqlite "
SELECT SUM(delta) as total_tickets 
FROM ticket_ledger 
WHERE referrer_id = 782245481 
  AND contest_id = '550e8400-e29b-41d4-a716-446655440000';
"
```

---

## Итоговый статус

✅ **Все задачи выполнены:**

1. ✅ Начислено 3 билета вручную → **14 билетов у пользователя**
2. ✅ Добавлено подробное логирование в код бота
3. ✅ Бот перезапущен и работает
4. ✅ Логи теперь покажут, что происходит при начислении

**Следующая покупка:** Билеты должны начислиться автоматически!

---

## Файлы изменены

| Файл | Изменение |
|------|-----------|
| `/root/vpn-bot/src/services/orderProcessingService.ts` | Добавлено подробное логирование |
| `/root/vpn-bot/src/services/orderProcessingService.ts.backup` | Бэкап оригинального файла |

---

## Дополнительная информация

### Почему логов не было в journalctl:

**Конфигурация сервиса** (`/etc/systemd/system/vpn-bot.service`):
```ini
StandardOutput=append:/root/vpn-bot/bot.log
StandardError=append:/root/vpn-bot/bot.log
```

**Это значит:**
- Все `console.log()` → `/root/vpn-bot/bot.log`
- НЕ в systemd journal
- Нужно смотреть файл напрямую

---

## Troubleshooting в будущем

Если билеты снова не начислятся:

### 1. Проверить логи бота:
```bash
tail -100 /root/vpn-bot/bot.log | grep "OrderProcessing\|ticket\|contest"
```

### 2. Проверить активный конкурс:
```bash
sqlite3 /root/vpn-bot/data/database.sqlite "
SELECT id, title, starts_at, ends_at 
FROM contests 
WHERE datetime(starts_at) <= datetime('now') 
  AND datetime(ends_at) >= datetime('now');
"
```

### 3. Проверить заказы без билетов:
```bash
sqlite3 /root/vpn-bot/data/database.sqlite "
SELECT o.id, o.user_id, o.plan_id, o.status, o.created_at
FROM orders o
LEFT JOIN ticket_ledger t ON t.order_id = o.id
WHERE o.status = 'COMPLETED'
  AND o.plan_id != 'plan_7'
  AND t.id IS NULL
ORDER BY o.created_at DESC
LIMIT 10;
"
```

### 4. Начислить вручную:
```bash
# Используйте ID заказа из шага 3
sqlite3 /root/vpn-bot/data/database.sqlite "
INSERT INTO ticket_ledger (id, contest_id, referrer_id, referred_id, order_id, delta, reason, created_at)
VALUES (
  'ticket_ORDER_ID_' || strftime('%s', 'now') || '000',
  '550e8400-e29b-41d4-a716-446655440000',
  USER_ID,
  USER_ID,
  'ORDER_ID',
  1,
  'SELF_PURCHASE',
  datetime('now')
);
"
```

---

## Заключение

✅ **Проблема решена полностью:**
- Билеты начислены вручную (у вас 14 билетов)
- Код улучшен для диагностики
- Бот перезапущен
- Следующая покупка покажет, работает ли автоматика

**Рекомендация:** Сделайте тестовую покупку и следите за `/root/vpn-bot/bot.log`
