# Анализ: Билеты не начислились

**Дата:** 2025-01-18 04:40 UTC  
**Проблема:** Пользователь купил подписку, но билеты не начислились

---

## Факты

### 1. Последние заказы пользователя (ID: 782245481)

| Order ID | Plan | Status | Created | Activated |
|----------|------|--------|---------|-----------|
| `ord_1c186eab...` | plan_30 | COMPLETED | 04:22:42 | 04:23:08 |
| `ord_b9cf0b5b...` | plan_30 | COMPLETED | 03:57:19 | 03:57:51 |
| `ord_63d529be...` | plan_30 | COMPLETED | 03:41:48 | 03:42:43 |

**Результат:** ✅ Все заказы COMPLETED и активированы

---

### 2. Билеты в таблице `ticket_ledger`

Запрос:
```sql
SELECT * FROM ticket_ledger 
WHERE order_id IN ('ord_1c186eab...', 'ord_b9cf0b5b...', 'ord_63d529be...');
```

**Результат:** ❌ **ПУСТО** - билеты НЕ начислены!

---

### 3. Последние начисленные билеты

```
ticket_ord_a357d644... | 03:12:19 | SELF_PURCHASE
ticket_ord_02f76367... | 02:17:28 | SELF_PURCHASE
ticket_ord_5903a2e6... | 02:08:01 | SELF_PURCHASE
```

**Последнее начисление:** 03:12:19 (до перезапуска бота)

---

### 4. Статус бота

```bash
● vpn-bot.service - vpn-bot Service
     Active: active (running) since Sun 2026-01-18 03:12:01 UTC
```

**Бот перезапущен:** 03:12:01  
**Логи после перезапуска:** ❌ **ОТСУТСТВУЮТ**

---

### 5. Логи API (vpn-core)

**Запросы за последние 2 часа:**
- ✅ API работает нормально
- ✅ Пользователь делает запросы (`/v1/referral/tickets`, `/v1/auth/me`)
- ❌ **НЕТ webhook запросов** от YooKassa
- ❌ **НЕТ логов о начислении билетов**

---

## Причина проблемы

### Основная причина: Бот не логирует после перезапуска

**Симптомы:**
1. Бот запущен и работает (active (running))
2. Заказы создаются и активируются (COMPLETED)
3. **НО логи НЕ пишутся**

**Код начисления существует:**
```typescript
// /root/vpn-bot/src/services/orderProcessingService.ts
const ticketAwarded = ContestService.awardSelfPurchaseTicket(
    activeContest.id,
    order.userId,
    order.id,
    order.planId,
    order.createdAt
);
if (ticketAwarded) {
    console.log(`[OrderProcessing] ✅ Successfully awarded self-purchase ticket...`);
} else {
    console.log(`[OrderProcessing] ⚠️ Failed to award self-purchase ticket...`);
}
```

**НО логи не появляются** → функция НЕ вызывается или логи идут не туда!

---

### Вторая причина: Платежи идут через Telegram, не через YooKassa

**Факты:**
- Заказы создаются через бота (provider: yoomoney в таблице)
- Но webhook на API НЕ приходит
- API настроен только на YooKassa webhook (`/v1/payments/webhook`)
- Telegram Payments могут использовать другой путь

---

## Возможные проблемы

### 1. Логи бота перенаправлены в файл

**Проверить:**
```bash
# Проверить конфигурацию сервиса
cat /etc/systemd/system/vpn-bot.service

# Проверить логи в файле
ls -la /root/vpn-bot/logs/
cat /root/vpn-bot/logs/*.log 2>/dev/null | tail -100
```

---

### 2. Бот не вызывает начисление билетов

**Возможные причины:**
- Условие `if (activeContest)` не срабатывает
- Функция `getActiveContest()` возвращает `null`
- Код начисления был закомментирован

**Проверить:**
```bash
# Проверить актуальный код
cat /root/vpn-bot/src/services/orderProcessingService.ts | grep -B 5 -A 15 "awardSelfPurchaseTicket"

# Проверить, компилируется ли код правильно
cat /root/vpn-bot/dist/*.js | grep "awardSelfPurchaseTicket"
```

---

### 3. Заказы обрабатываются без вызова `orderProcessingService`

**Возможные причины:**
- Telegram Payments обходят стандартную обработку
- Webhook от Telegram идет напрямую в БД
- Используется старый код активации

**Проверить:**
```bash
# Найти все места, где orders обновляются
grep -r "UPDATE orders" /root/vpn-bot/src --include="*.ts"
grep -r "status.*COMPLETED" /root/vpn-bot/src --include="*.ts"
```

---

## Решение

### Краткосрочное: Начислить билеты вручную

```bash
ssh root@72.56.93.135

# Запустить скрипт ручного начисления для 3 заказов
node /opt/vpn-core/scripts/manual-award-tickets.js \
  ord_1c186eab-f535-45e4-893c-a522a272fccc \
  ord_b9cf0b5b-a325-4495-a7c8-1c1fad0a89d1 \
  ord_63d529be-7d0d-4059-bae3-012573f8965b
```

**Ожидаемый результат:**
```
✅ Awarded 1 ticket for order ord_1c186eab...
✅ Awarded 1 ticket for order ord_b9cf0b5b...
✅ Awarded 1 ticket for order ord_63d529be...
Total: 3 tickets awarded
```

---

### Долгосрочное: Исправить автоматическое начисление

#### Шаг 1: Включить подробное логирование в боте

```typescript
// /root/vpn-bot/src/services/orderProcessingService.ts

export async function processPayment(order: Order): Promise<void> {
    console.log(`[OrderProcessing] 🚀 STARTED processing payment for order ${order.id}`);
    console.log(`[OrderProcessing] Order details:`, {
        id: order.id,
        userId: order.userId,
        planId: order.planId,
        status: order.status,
        createdAt: order.createdAt
    });

    // Проверяем активный конкурс
    const activeContest = ContestService.getActiveContest();
    console.log(`[OrderProcessing] Active contest:`, activeContest ? {
        id: activeContest.id,
        title: activeContest.title
    } : 'NONE');

    if (activeContest) {
        console.log(`[OrderProcessing] Attempting to award self-purchase ticket...`);
        const ticketAwarded = ContestService.awardSelfPurchaseTicket(
            activeContest.id,
            order.userId,
            order.id,
            order.planId,
            order.createdAt
        );
        console.log(`[OrderProcessing] Ticket award result: ${ticketAwarded ? 'SUCCESS ✅' : 'FAILED ❌'}`);
    } else {
        console.log(`[OrderProcessing] ⚠️ No active contest, skipping ticket award`);
    }
}
```

#### Шаг 2: Перекомпилировать и перезапустить бота

```bash
cd /root/vpn-bot
npm run build
systemctl restart vpn-bot
journalctl -u vpn-bot -f
```

#### Шаг 3: Протестировать покупку

1. Купить тестовую подписку через бота
2. Проверить логи:
   ```bash
   journalctl -u vpn-bot -n 50 --no-pager | grep "OrderProcessing"
   ```
3. Проверить начисление:
   ```bash
   sqlite3 /root/vpn-bot/data/database.sqlite \
     "SELECT * FROM ticket_ledger ORDER BY created_at DESC LIMIT 5;"
   ```

---

## Проверка исправления

### 1. Логи должны показывать:

```
[OrderProcessing] 🚀 STARTED processing payment for order ord_...
[OrderProcessing] Order details: { id: '...', userId: 782245481, ... }
[OrderProcessing] Active contest: { id: '550e8400...', title: '🎉 Розыгрыш...' }
[OrderProcessing] Attempting to award self-purchase ticket...
[OrderProcessing] Ticket award result: SUCCESS ✅
```

### 2. В базе данных:

```sql
SELECT id, referrer_id, referred_id, order_id, delta, reason, created_at 
FROM ticket_ledger 
WHERE order_id = 'ord_...'
ORDER BY created_at DESC 
LIMIT 1;
```

**Ожидаемый результат:**
```
ticket_ord_...   | 782245481 | 782245481 | ord_... | 1 | SELF_PURCHASE | 2026-01-18 ...
```

---

## Временное решение СЕЙЧАС

Пока я исправляю код, **начислить билеты вручную** для этих 3 заказов.

**Вопрос пользователю:** Хотите, чтобы я:
1. ✅ **Начислил билеты вручную прямо сейчас** (3 билета)
2. ✅ **Исправил код бота** для автоматического начисления в будущем
3. ✅ **Протестировал** новую покупку

Какой вариант выбираете?
