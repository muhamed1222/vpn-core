# Как начислить билеты вручную через SQL

## Процесс ручного начисления билетов

Я использую прямой SQL запрос к базе данных бота (`/root/vpn-bot/data/database.sqlite`) для вставки записи в таблицу `ticket_ledger`.

---

## Шаг 1: Проверка заказа

```sql
SELECT id, user_id, plan_id, status, created_at 
FROM orders 
WHERE id = 'ord_xxxxx';
```

**Результат:** Убеждаемся, что заказ существует и имеет статус `COMPLETED` или `PAID`.

---

## Шаг 2: Проверка активного конкурса

```sql
SELECT id, title, is_active, starts_at, ends_at 
FROM contests 
WHERE is_active = 1 
ORDER BY starts_at DESC 
LIMIT 1;
```

**Результат:** Получаем ID активного конкурса (например, `550e8400-e29b-41d4-a716-446655440000`).

---

## Шаг 3: Проверка, что билеты еще не начислены

```sql
SELECT * 
FROM ticket_ledger 
WHERE order_id = 'ord_xxxxx' 
  AND reason = 'SELF_PURCHASE';
```

**Результат:** Если записей нет → можно начислять. Если есть → билеты уже начислены (идемпотентность).

---

## Шаг 4: Ручное начисление билета

### Для SELF_PURCHASE (покупателю):

```sql
INSERT INTO ticket_ledger (
  id, contest_id, referrer_id, referred_id, order_id, delta, reason, created_at
)
SELECT 
  'ticket_' || o.id || '_' || strftime('%s', 'now'),  -- Уникальный ID
  '550e8400-e29b-41d4-a716-446655440000',             -- ID активного конкурса
  o.user_id,                                           -- referrer_id = пользователь
  o.user_id,                                           -- referred_id = пользователь
  o.id,                                                -- order_id
  CASE 
    WHEN o.plan_id = 'plan_30' THEN 1
    WHEN o.plan_id = 'plan_90' THEN 3
    WHEN o.plan_id = 'plan_180' THEN 6
    WHEN o.plan_id = 'plan_365' THEN 12
    ELSE 1
  END,                                                 -- delta = количество билетов
  'SELF_PURCHASE',                                     -- reason
  datetime('now')                                      -- created_at
FROM orders o
WHERE o.id = 'ord_xxxxx'
  AND NOT EXISTS (
    SELECT 1 FROM ticket_ledger 
    WHERE order_id = o.id 
    AND reason = 'SELF_PURCHASE'
  );
```

### Пример реального запроса:

```sql
INSERT INTO ticket_ledger (
  id, contest_id, referrer_id, referred_id, order_id, delta, reason, created_at
)
SELECT 
  'ticket_' || 'ord_a357d644-cdf0-4f97-9c65-8c8ca9b84b3e' || '_' || strftime('%s', 'now'),
  '550e8400-e29b-41d4-a716-446655440000',
  o.user_id,
  o.user_id,
  o.id,
  CASE 
    WHEN o.plan_id = 'plan_30' THEN 1
    WHEN o.plan_id = 'plan_90' THEN 3
    WHEN o.plan_id = 'plan_180' THEN 6
    WHEN o.plan_id = 'plan_365' THEN 12
    ELSE 1
  END,
  'SELF_PURCHASE',
  datetime('now')
FROM orders o
WHERE o.id = 'ord_a357d644-cdf0-4f97-9c65-8c8ca9b84b3e'
  AND NOT EXISTS (
    SELECT 1 FROM ticket_ledger 
    WHERE order_id = o.id 
    AND reason = 'SELF_PURCHASE'
  );
```

---

## Структура таблицы ticket_ledger

| Поле | Тип | Описание | Пример |
|------|-----|----------|--------|
| `id` | TEXT | Уникальный ID билета | `ticket_ord_xxx_1768704739` |
| `contest_id` | TEXT | ID конкурса | `550e8400-e29b-41d4-a716-446655440000` |
| `referrer_id` | INTEGER | Кто получает билет | `782245481` |
| `referred_id` | INTEGER | Кто купил (для INVITEE_PAYMENT) | `782245481` |
| `order_id` | TEXT | ID заказа | `ord_xxxxx` |
| `delta` | INTEGER | Количество билетов | `1`, `3`, `6`, `12` |
| `reason` | TEXT | Причина начисления | `SELF_PURCHASE` или `INVITEE_PAYMENT` |
| `created_at` | TEXT | Дата создания (ISO) | `2026-01-18 03:12:19` |

---

## Логика определения количества билетов (delta)

```sql
CASE 
  WHEN plan_id = 'plan_30' THEN 1   -- 1 месяц = 1 билет
  WHEN plan_id = 'plan_90' THEN 3   -- 3 месяца = 3 билета
  WHEN plan_id = 'plan_180' THEN 6  -- 6 месяцев = 6 билетов
  WHEN plan_id = 'plan_365' THEN 12 -- 12 месяцев = 12 билетов
  ELSE 1                             -- По умолчанию 1 билет
END
```

**Правило:** Количество месяцев подписки = количество билетов.

---

## Защита от дубликатов (идемпотентность)

Запрос использует `NOT EXISTS` для проверки, что билеты еще не начислены:

```sql
AND NOT EXISTS (
  SELECT 1 FROM ticket_ledger 
  WHERE order_id = o.id 
  AND reason = 'SELF_PURCHASE'
)
```

**Результат:** Если билеты уже начислены, запрос не вставит дубликат.

---

## Пример реального начисления

Для заказа `ord_a357d644-cdf0-4f97-9c65-8c8ca9b84b3e`:

**Запрос:**
```sql
INSERT INTO ticket_ledger (
  id, contest_id, referrer_id, referred_id, order_id, delta, reason, created_at
)
SELECT 
  'ticket_' || 'ord_a357d644-cdf0-4f97-9c65-8c8ca9b84b3e' || '_' || strftime('%s', 'now'),
  '550e8400-e29b-41d4-a716-446655440000',
  782245481,  -- user_id из заказа
  782245481,  -- user_id из заказа
  'ord_a357d644-cdf0-4f97-9c65-8c8ca9b84b3e',
  1,          -- plan_30 = 1 билет
  'SELF_PURCHASE',
  datetime('now')
FROM orders o
WHERE o.id = 'ord_a357d644-cdf0-4f97-9c65-8c8ca9b84b3e'
  AND NOT EXISTS (...);
```

**Результат:**
```
✅ Билет начислен
```

**Проверка:**
```sql
SELECT * FROM ticket_ledger WHERE order_id = 'ord_a357d644-cdf0-4f97-9c65-8c8ca9b84b3e';
```

```
ord_a357d644...|550e8400-...|782245481|782245481|ord_a357d644...|1|SELF_PURCHASE|2026-01-18 03:12:19
```

---

## Команда для быстрого начисления

```bash
ssh root@72.56.93.135 "cd /root/vpn-bot && sqlite3 data/database.sqlite \"
INSERT INTO ticket_ledger (
  id, contest_id, referrer_id, referred_id, order_id, delta, reason, created_at
)
SELECT 
  'ticket_' || o.id || '_' || strftime('%s', 'now'),
  '550e8400-e29b-41d4-a716-446655440000',
  o.user_id,
  o.user_id,
  o.id,
  CASE 
    WHEN o.plan_id = 'plan_30' THEN 1
    WHEN o.plan_id = 'plan_90' THEN 3
    WHEN o.plan_id = 'plan_180' THEN 6
    WHEN o.plan_id = 'plan_365' THEN 12
    ELSE 1
  END,
  'SELF_PURCHASE',
  datetime('now')
FROM orders o
WHERE o.id = 'ORDER_ID_HERE'
  AND NOT EXISTS (
    SELECT 1 FROM ticket_ledger 
    WHERE order_id = o.id 
    AND reason = 'SELF_PURCHASE'
  );
SELECT '✅ Билет начислен';
\""
```

**Замените `ORDER_ID_HERE` на реальный ID заказа.**

---

## Важные моменты

1. ✅ **Идемпотентность:** Запрос проверяет, что билеты еще не начислены
2. ✅ **Автоматический расчет:** Количество билетов определяется из `plan_id`
3. ✅ **Уникальный ID:** ID билета генерируется автоматически
4. ✅ **Активный конкурс:** Используется ID активного конкурса
5. ✅ **Дата/время:** `created_at` устанавливается автоматически

---

## Альтернатива: Использование функции из кода

Вместо прямого SQL, можно было бы вызвать функцию из кода:

```typescript
// Из кода бота (не через SQL, а через API/код)
ContestService.awardSelfPurchaseTicket(
  contestId,
  userId,
  orderId,
  planId,
  orderCreatedAt
);
```

Но для быстрого исправления проще использовать прямой SQL запрос.
