# Руководство по настройке автоматического начисления билетов

> Основано на документации Fastify, better-sqlite3 и node-cron от Context7

---

## 1. Архитектура автоначисления

### 1.1. Три точки входа

```
┌─────────────────────────────────────────────────────────────┐
│                    ТОЧКИ ВХОДА                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Webhook от YooKassa → API                               │
│     POST /v1/payments/webhook                               │
│                                                              │
│  2. Обработка в боте → OrderProcessingService               │
│     processPayment() → activateOrder()                      │
│                                                              │
│  3. Планировщик задач → node-cron (опционально)             │
│     Проверка незавершенных начислений                       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Настройка webhook обработки (Fastify)

### 2.1. Улучшенная обработка webhook с try-catch и логированием

**Файл:** `src/routes/v1/payments.ts`

```typescript
fastify.post('/v1/payments/webhook', {
  schema: {
    body: {
      type: 'object',
      required: ['event', 'object'],
      properties: {
        event: { type: 'string' },
        object: { type: 'object' }
      }
    }
  },
  // Используем async/await для автоматической обработки промисов
  handler: async (request, reply) => {
    const { event, object } = request.body;
    
    try {
      // Валидация события
      if (event !== 'payment.succeeded') {
        fastify.log.debug({ event }, '[Webhook] Event ignored');
        return reply.code(200).send({ status: 'ignored' });
      }
      
      // Извлечение данных заказа
      const orderId = object.metadata?.order_id;
      const tgId = object.metadata?.telegram_id;
      const planId = object.metadata?.plan_id;
      const orderCreatedAt = object.metadata?.created_at;
      
      if (!orderId || !tgId || !planId) {
        fastify.log.warn({ object }, '[Webhook] Missing required metadata');
        return reply.code(400).send({ error: 'Missing metadata' });
      }
      
      // АКТИВНОЕ НАЧИСЛЕНИЕ БИЛЕТОВ
      // Используем try-catch для изоляции ошибок начисления от основного потока
      try {
        const ticketsAwarded = await awardTicketsForPayment(
          botDbPath,
          tgId,
          orderId,
          planId,
          orderCreatedAt
        );
        
        if (ticketsAwarded) {
          fastify.log.info({ 
            tgId, 
            orderId, 
            planId 
          }, '[Webhook] ✅ Tickets awarded successfully');
        } else {
          fastify.log.debug({ 
            tgId, 
            orderId 
          }, '[Webhook] No tickets awarded (no referrer or outside contest period)');
        }
      } catch (ticketError: any) {
        // НЕ прерываем основной поток - оплата уже обработана
        fastify.log.error({ 
          err: ticketError?.message, 
          stack: ticketError?.stack,
          tgId, 
          orderId 
        }, '[Webhook] ❌ Failed to award tickets (non-critical)');
        
        // Опционально: сохранить в очередь для повторной попытки
        // await saveFailedAward(tgId, orderId, planId, orderCreatedAt);
      }
      
      // Продолжаем обработку платежа (активация VPN и т.д.)
      // ...
      
      return reply.code(200).send({ status: 'processed' });
      
    } catch (error: any) {
      fastify.log.error({ 
        err: error?.message, 
        stack: error?.stack 
      }, '[Webhook] Critical error processing webhook');
      
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }
});
```

### 2.2. Использование preHandler hook для общей валидации

```typescript
// Глобальный hook для всех webhook endpoints
fastify.addHook('preHandler', async (request, reply) => {
  // Валидация подписи YooKassa (если требуется)
  const signature = request.headers['x-yookassa-signature'];
  if (!validateSignature(request.body, signature)) {
    fastify.log.warn({ ip: request.ip }, '[Webhook] Invalid signature');
    throw new Error('Invalid signature');
  }
  
  // Логирование входящего webhook
  fastify.log.info({ 
    method: request.method, 
    url: request.url,
    event: request.body?.event 
  }, '[Webhook] Incoming request');
});

// Специфичный hook для платежных webhooks
fastify.post('/v1/payments/webhook', {
  preHandler: async (request, reply) => {
    // Дополнительная валидация для платежей
    if (!request.body?.object?.id) {
      throw new Error('Missing payment ID');
    }
  },
  handler: async (request, reply) => {
    // ...
  }
});
```

---

## 3. Надежность транзакций (better-sqlite3)

### 3.1. Использование транзакций для атомарности

**Проблема:** Начисление билетов должно быть атомарным - если что-то пошло не так, все изменения должны откатиться.

**Решение:** Использовать `db.transaction()` для группировки операций.

**Файл:** `src/storage/contestUtils.ts` (улучшенная версия)

```typescript
export async function awardTicketsForPayment(
  botDbPath: string,
  referredTgId: number,
  orderId: string,
  planId: string,
  orderCreatedAt: string
): Promise<boolean> {
  const db = getDatabase();
  
  try {
    // Прикрепляем базу бота
    db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    
    // ОБОРАЧИВАЕМ ВСЕ ОПЕРАЦИИ В ТРАНЗАКЦИЮ
    const awardTicketsTransaction = db.transaction((
      contestId: string,
      referredId: number,
      referrerId: number | null,
      orderId: string,
      ticketsDelta: number
    ) => {
      const now = new Date().toISOString();
      
      // 1. Всегда начисляем покупателю (SELF_PURCHASE)
      const selfTicketId = `ticket_self_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      db.prepare(`
        INSERT INTO bot_db.ticket_ledger (
          id, contest_id, referrer_id, referred_id, order_id, delta, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'SELF_PURCHASE', ?)
      `).run(selfTicketId, contestId, referredId, referredId, orderId, ticketsDelta, now);
      
      // 2. Условно начисляем рефереру (INVITEE_PAYMENT)
      if (referrerId !== null) {
        const referrerTicketId = `ticket_ref_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        db.prepare(`
          INSERT INTO bot_db.ticket_ledger (
            id, contest_id, referrer_id, referred_id, order_id, delta, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'INVITEE_PAYMENT', ?)
        `).run(referrerTicketId, contestId, referrerId, referredId, orderId, ticketsDelta, now);
        
        // 3. Обновляем ref_events (в той же транзакции)
        const existingEvent = db.prepare(`
          SELECT id, status
          FROM bot_db.ref_events
          WHERE contest_id = ? AND referrer_id = ? AND referred_id = ?
          LIMIT 1
        `).get(contestId, referrerId, referredId);
        
        if (existingEvent) {
          db.prepare(`
            UPDATE bot_db.ref_events
            SET status = 'qualified', qualified_at = ?
            WHERE id = ?
          `).run(now, existingEvent.id);
        } else {
          const eventId = `ref_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          db.prepare(`
            INSERT INTO bot_db.ref_events (
              id, contest_id, referrer_id, referred_id, bound_at, status, qualified_at
            ) VALUES (?, ?, ?, ?, ?, 'qualified', ?)
          `).run(eventId, contestId, referrerId, referredId, now, now);
        }
      }
    });
    
    // Получаем активный конкурс
    const contest = db.prepare(`
      SELECT id, starts_at, ends_at, attribution_window_days
      FROM bot_db.contests
      WHERE is_active = 1
      ORDER BY starts_at DESC
      LIMIT 1
    `).get() as Contest | undefined;
    
    if (!contest) {
      return false;
    }
    
    // Проверка периода конкурса
    const orderDate = new Date(orderCreatedAt);
    const contestStart = new Date(contest.starts_at);
    const contestEnd = new Date(contest.ends_at);
    
    if (orderDate < contestStart || orderDate > contestEnd) {
      return false;
    }
    
    // Проверка квалификации реферера
    const referral = db.prepare(`
      SELECT referrer_id, bound_at
      FROM bot_db.user_referrals
      WHERE referred_id = ?
    `).get(referredTgId) as { referrer_id: number; bound_at: string } | undefined;
    
    let referrerId: number | null = null;
    
    if (referral) {
      referrerId = referral.referrer_id;
      
      // Все проверки квалификации здесь...
      // ...
    }
    
    // Определение количества билетов
    const ticketsDelta = getTicketsFromPlanId(planId);
    
    // ВЫПОЛНЯЕМ ТРАНЗАКЦИЮ (автоматически COMMIT при успехе, ROLLBACK при ошибке)
    awardTicketsTransaction(
      contest.id,
      referredTgId,
      referrerId,
      orderId,
      ticketsDelta
    );
    
    return true;
    
  } catch (error) {
    // Если произошла ошибка, транзакция автоматически откатится
    console.error(`[awardTicketsForPayment] Transaction failed:`, error);
    throw error; // Пробрасываем ошибку дальше
  } finally {
    // Всегда отключаем базу
    db.prepare('DETACH DATABASE bot_db').run();
  }
}
```

### 3.2. Обработка ошибок транзакций

```typescript
try {
  awardTicketsTransaction(...);
} catch (err: any) {
  // Проверяем, была ли транзакция принудительно откачена
  if (!db.inTransaction) {
    console.error('[Transaction] Transaction was forcefully rolled back by SQLite');
    throw err; // Перебрасываем ошибку
  }
  
  // Другие типы ошибок (валидация, логика и т.д.)
  console.error('[Transaction] Error in transaction:', err);
  throw err;
}
```

### 3.3. Режимы транзакций для оптимизации

```typescript
// DEFERRED (по умолчанию) - начинает транзакцию только при первой записи
awardTicketsTransaction.deferred(contestId, referredId, referrerId, orderId, ticketsDelta);

// IMMEDIATE - резервирует блокировку записи сразу
awardTicketsTransaction.immediate(contestId, referredId, referrerId, orderId, ticketsDelta);

// EXCLUSIVE - эксклюзивная блокировка всей базы
awardTicketsTransaction.exclusive(contestId, referredId, referrerId, orderId, ticketsDelta);
```

**Рекомендация:** Для начисления билетов используйте `DEFERRED` (по умолчанию), так как операции быстрые и конфликты редки.

---

## 4. Планировщик задач для повторных попыток (node-cron)

### 4.1. Установка node-cron

```bash
npm install node-cron
npm install --save-dev @types/node-cron
```

### 4.2. Создание планировщика для проверки незавершенных начислений

**Файл:** `src/services/awardRetryScheduler.ts` (новый)

```typescript
import { CronJob } from 'node-cron';

interface FailedAward {
  tgId: number;
  orderId: string;
  planId: string;
  orderCreatedAt: string;
  attemptCount: number;
  lastAttemptAt: string;
  error?: string;
}

class AwardRetryScheduler {
  private retryQueue: Map<string, FailedAward> = new Map();
  
  // Планировщик: каждые 5 минут проверяет очередь и повторяет начисление
  private retryJob: CronJob;
  
  constructor(
    private awardFunction: (
      botDbPath: string,
      tgId: number,
      orderId: string,
      planId: string,
      orderCreatedAt: string
    ) => Promise<boolean>
  ) {
    // Создаем cron job: каждые 5 минут
    this.retryJob = CronJob.from({
      cronTime: '*/5 * * * *', // Каждые 5 минут
      onTick: async () => {
        await this.processRetryQueue();
      },
      start: true,
      timeZone: 'UTC',
      name: 'Ticket Award Retry',
      errorHandler: (err) => {
        console.error('[AwardRetryScheduler] Cron job error:', err);
      }
    });
    
    console.log('[AwardRetryScheduler] ✅ Retry scheduler started (runs every 5 minutes)');
  }
  
  /**
   * Добавить неудачное начисление в очередь повторных попыток
   */
  addToRetryQueue(
    tgId: number,
    orderId: string,
    planId: string,
    orderCreatedAt: string,
    error?: string
  ): void {
    const key = `${tgId}_${orderId}`;
    
    const existing = this.retryQueue.get(key);
    if (existing) {
      // Обновляем счетчик попыток
      existing.attemptCount += 1;
      existing.lastAttemptAt = new Date().toISOString();
      existing.error = error;
    } else {
      // Создаем новую запись
      this.retryQueue.set(key, {
        tgId,
        orderId,
        planId,
        orderCreatedAt,
        attemptCount: 1,
        lastAttemptAt: new Date().toISOString(),
        error
      });
    }
    
    console.log(`[AwardRetryScheduler] Added to retry queue: ${key} (attempt ${this.retryQueue.get(key)!.attemptCount})`);
  }
  
  /**
   * Обработать очередь повторных попыток
   */
  private async processRetryQueue(): Promise<void> {
    if (this.retryQueue.size === 0) {
      return; // Очередь пуста
    }
    
    console.log(`[AwardRetryScheduler] Processing ${this.retryQueue.size} items in retry queue...`);
    
    const botDbPath = process.env.BOT_DB_PATH || '/root/vpn-bot/data/bot.db';
    const maxAttempts = 3; // Максимум 3 попытки
    const itemsToRetry: string[] = [];
    
    // Собираем ключи для повторной попытки
    for (const [key, item] of this.retryQueue.entries()) {
      if (item.attemptCount <= maxAttempts) {
        itemsToRetry.push(key);
      } else {
        // Превышен лимит попыток - удаляем из очереди
        console.warn(`[AwardRetryScheduler] Max attempts reached for ${key}, removing from queue`);
        this.retryQueue.delete(key);
      }
    }
    
    // Повторяем начисление
    for (const key of itemsToRetry) {
      const item = this.retryQueue.get(key)!;
      
      try {
        console.log(`[AwardRetryScheduler] Retrying award for ${key} (attempt ${item.attemptCount + 1})...`);
        
        const success = await this.awardFunction(
          botDbPath,
          item.tgId,
          item.orderId,
          item.planId,
          item.orderCreatedAt
        );
        
        if (success) {
          // Успешно начислено - удаляем из очереди
          console.log(`[AwardRetryScheduler] ✅ Successfully awarded tickets for ${key}`);
          this.retryQueue.delete(key);
        } else {
          // Не удалось (нет активного конкурса, вне периода и т.д.)
          // Обновляем счетчик попыток
          item.attemptCount += 1;
          item.lastAttemptAt = new Date().toISOString();
        }
        
      } catch (error: any) {
        // Ошибка при начислении - обновляем счетчик
        console.error(`[AwardRetryScheduler] ❌ Error retrying ${key}:`, error?.message);
        item.attemptCount += 1;
        item.lastAttemptAt = new Date().toISOString();
        item.error = error?.message;
      }
    }
    
    console.log(`[AwardRetryScheduler] Processed retry queue. Remaining: ${this.retryQueue.size}`);
  }
  
  /**
   * Остановить планировщик
   */
  stop(): void {
    this.retryJob.stop();
    console.log('[AwardRetryScheduler] Retry scheduler stopped');
  }
  
  /**
   * Получить статистику очереди
   */
  getStats(): { queueSize: number; items: FailedAward[] } {
    return {
      queueSize: this.retryQueue.size,
      items: Array.from(this.retryQueue.values())
    };
  }
}

export const awardRetryScheduler = new AwardRetryScheduler(
  awardTicketsForPayment // Передаем функцию начисления
);
```

### 4.3. Интеграция в webhook handler

**Файл:** `src/routes/v1/payments.ts` (обновленный)

```typescript
import { awardRetryScheduler } from '../services/awardRetryScheduler';

fastify.post('/v1/payments/webhook', {
  handler: async (request, reply) => {
    // ...
    
    try {
      const ticketsAwarded = await awardTicketsForPayment(...);
      
      if (ticketsAwarded) {
        fastify.log.info({ tgId, orderId }, '[Webhook] ✅ Tickets awarded');
      }
    } catch (ticketError: any) {
      fastify.log.error({ err: ticketError?.message, tgId, orderId }, '[Webhook] ❌ Failed to award tickets');
      
      // ДОБАВЛЯЕМ В ОЧЕРЕДЬ ПОВТОРНЫХ ПОПЫТОК
      awardRetryScheduler.addToRetryQueue(
        tgId,
        orderId,
        planId,
        orderCreatedAt,
        ticketError?.message
      );
    }
    
    // ...
  }
});
```

### 4.4. API endpoint для мониторинга очереди

```typescript
fastify.get('/v1/admin/award-retry-stats', {
  preHandler: [requireAdminAuth], // Ваша функция авторизации
  handler: async (request, reply) => {
    const stats = awardRetryScheduler.getStats();
    return reply.send(stats);
  }
});
```

---

## 5. Контрольный список настройки

### ✅ Webhook обработка

- [ ] Использовать `async/await` в route handlers
- [ ] Обернуть начисление в `try-catch` (не прерывать основной поток)
- [ ] Добавить логирование всех этапов
- [ ] Валидация входящих данных через `schema`

### ✅ Транзакции базы данных

- [ ] Обернуть все операции в `db.transaction()`
- [ ] Использовать `DEFERRED` режим (по умолчанию)
- [ ] Обработать ошибки транзакций (`db.inTransaction` check)
- [ ] Всегда использовать `finally` для очистки (`DETACH DATABASE`)

### ✅ Планировщик задач (опционально)

- [ ] Установить `node-cron`
- [ ] Создать `AwardRetryScheduler` класс
- [ ] Настроить cron: `*/5 * * * *` (каждые 5 минут)
- [ ] Интегрировать в webhook handler
- [ ] Добавить endpoint для мониторинга очереди

### ✅ Логирование и мониторинг

- [ ] Логировать все успешные начисления
- [ ] Логировать все ошибки с контекстом
- [ ] Добавить метрики (количество начислений, ошибок, повторов)
- [ ] Создать дашборд для мониторинга

---

## 6. Примеры cron-выражений

```typescript
'*/5 * * * *'      // Каждые 5 минут
'0 * * * *'        // Каждый час
'0 */6 * * *'      // Каждые 6 часов
'0 0 * * *'        // Каждый день в полночь
'0 0 * * 0'        // Каждое воскресенье в полночь
'0 9-17 * * 1-5'   // Каждый час с 9 до 17, понедельник-пятница
```

---

## 7. Заключение

Автоматическое начисление билетов настраивается через:

1. **Webhooks (Fastify)** - основная точка входа для обработки платежей
2. **Транзакции (better-sqlite3)** - гарантируют атомарность операций
3. **Планировщик (node-cron)** - обеспечивает надежность через повторные попытки

**Важно:** Все ошибки должны логироваться, но не должны прерывать основной поток обработки платежей. Используйте изоляцию через `try-catch` и очереди повторных попыток.
