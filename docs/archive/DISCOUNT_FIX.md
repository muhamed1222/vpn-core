# Исправление применения скидки в мини-приложении

## Проблема

Промокод применялся в боте и сохранялся в базе данных (`discount_percent`), но при создании заказа через мини-приложение скидка не применялась.

## Решение

Добавлена проверка скидки пользователя из базы данных бота в endpoint `/v1/orders/create` в `vpn-core`.

### Изменения

**Файл:** `vpn-core/src/routes/v1/orders.ts`

1. **Проверка скидки из базы бота:**
   - Подключается к базе данных бота (`/root/vpn-bot/data/database.sqlite`)
   - Проверяется поле `discount_percent` пользователя
   - Проверяется срок действия скидки (`discount_expires_at`)

2. **Применение скидки:**
   - Если скидка активна, применяется к цене заказа
   - Минимальная цена: 1 рубль (защита от нуля)
   - Логируется применение скидки

### Код

```typescript
// Проверяем скидку пользователя из базы бота
const botDbPath = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';
let discountPercent = 0;

if (fs.existsSync(botDbPath)) {
  // Подключаемся к базе бота и проверяем скидку
  const userRow = db.prepare(`
    SELECT discount_percent, discount_expires_at 
    FROM bot_db.users 
    WHERE id = ?
  `).get(request.user.tgId || tgId);
  
  if (userRow && userRow.discount_percent && 
      (!userRow.discount_expires_at || userRow.discount_expires_at > Date.now())) {
    discountPercent = userRow.discount_percent;
  }
}

// Применяем скидку к цене
if (discountPercent > 0 && discountPercent <= 100) {
  const originalValue = parseFloat(amount.value);
  const discountedValue = Math.round((originalValue * (100 - discountPercent)) / 100);
  const finalValue = Math.max(1, discountedValue); // Минимум 1 рубль
  amount = {
    value: finalValue.toFixed(2),
    currency: amount.currency
  };
}
```

## Как это работает

1. **Пользователь активирует промокод в боте:**
   - Отправляет промокод боту (например, `MEGA99`)
   - Бот проверяет промокод и применяет скидку
   - Скидка сохраняется в `users.discount_percent` и `users.discount_expires_at`

2. **Пользователь создает заказ через мини-приложение:**
   - Мини-приложение вызывает `/api/orders/create`
   - `vpn-core` проверяет скидку в базе бота
   - Если скидка активна, применяется к цене заказа
   - Создается платеж в YooKassa с учетом скидки

3. **После покупки:**
   - Скидка сбрасывается в `orderProcessingService.ts` (строка 78-79)
   - Пользователь не может использовать скидку повторно

## Пример

**Без скидки:**
- Тариф: 99₽
- Цена заказа: 99₽

**Со скидкой 99%:**
- Тариф: 99₽
- Скидка: 99%
- Цена заказа: ~1₽ (минимум 1₽)

## Важно

- Скидка применяется только если она активна (не истекла)
- Минимальная цена заказа: 1 рубль
- Скидка сбрасывается после успешной покупки
- Промокод можно использовать только один раз
