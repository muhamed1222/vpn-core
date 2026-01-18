# 🔧 План исправления системы получения билетов

## Дата: 2025-01-27

---

## 📋 Обзор задач

План исправления всех критических проблем системы получения билетов.

**Приоритет:** 🔴 Критично - исправить перед следующим конкурсом

---

## ✅ Задача 1: Создать единую функцию конвертации plan_id → билеты

### Проблема
Конвертация `plan_id` → количество билетов захардкожена в 4+ местах в SQL запросах.

### Решение
Создать функцию `getTicketsFromPlanId()` и использовать везде.

### Шаги

#### Шаг 1.1: Создать утилиту для конвертации

**Файл:** `src/storage/contestUtils.ts` (создать новый файл)

```typescript
/**
 * Утилиты для работы с конкурсами
 */

/**
 * Конвертирует plan_id в количество билетов (месяцев)
 * 
 * Правила:
 * - plan_30 = 1 билет (1 месяц)
 * - plan_90 = 3 билета (3 месяца)
 * - plan_180 = 6 билетов (6 месяцев)
 * - plan_365 = 12 билетов (12 месяцев)
 * - plan_XXX (динамический) = XXX дней / 30 (округление вверх)
 * 
 * @param planId - ID плана (например, 'plan_30')
 * @returns Количество билетов (месяцев) или 0 для невалидных планов
 */
export function getTicketsFromPlanId(planId: string | null | undefined): number {
  if (!planId) {
    return 0;
  }

  // Фиксированные планы
  const fixedPlans: Record<string, number> = {
    'plan_30': 1,
    'plan_90': 3,
    'plan_180': 6,
    'plan_365': 12,
  };

  if (planId in fixedPlans) {
    return fixedPlans[planId];
  }

  // Динамические планы (plan_XXX где XXX = дни)
  if (planId.startsWith('plan_')) {
    const daysStr = planId.substring(5); // Извлекаем часть после 'plan_'
    const days = parseInt(daysStr, 10);
    
    if (!isNaN(days) && days > 0) {
      // Округляем вверх до месяца (7 дней = 1 месяц, 30 дней = 1 месяц)
      return Math.ceil(days / 30);
    }
  }

  // Невалидный plan_id - логируем предупреждение и возвращаем 0
  console.warn(`[getTicketsFromPlanId] Unknown plan_id: ${planId}`);
  return 0;
}

/**
 * SQL выражение для конвертации plan_id в билеты
 * Используется в SQL запросах, где нужна конвертация на уровне БД
 */
export function getTicketsFromPlanIdSQL(planIdColumn: string = 'plan_id'): string {
  return `
    CASE 
      WHEN ${planIdColumn} = 'plan_30' THEN 1
      WHEN ${planIdColumn} = 'plan_90' THEN 3
      WHEN ${planIdColumn} = 'plan_180' THEN 6
      WHEN ${planIdColumn} = 'plan_365' THEN 12
      WHEN ${planIdColumn} LIKE 'plan_%' THEN 
        CASE 
          WHEN CAST(SUBSTR(${planIdColumn}, 6) AS INTEGER) > 0 
          THEN CAST((CAST(SUBSTR(${planIdColumn}, 6) AS INTEGER) + 29) / 30 AS INTEGER)
          ELSE 0
        END
      ELSE 0
    END
  `.trim();
}
```

#### Шаг 1.2: Экспортировать функцию в index

**Файл:** `src/storage/index.ts` (если есть, добавить экспорт)

```typescript
export { getTicketsFromPlanId, getTicketsFromPlanIdSQL } from './contestUtils.js';
```

#### Шаг 1.3: Обновить все места использования в contestRepo.ts

**Файл:** `src/storage/contestRepo.ts`

1. **Добавить импорт в начало файла:**
```typescript
import { getTicketsFromPlanIdSQL } from './contestUtils.js';
```

2. **Заменить SQL в `getReferralSummary()` (строка ~261-270):**
```typescript
// БЫЛО:
const ticketsResult = db.prepare(`
  SELECT COALESCE(SUM(
    CASE 
      WHEN o.plan_id = 'plan_30' THEN 1
      WHEN o.plan_id = 'plan_90' THEN 3
      WHEN o.plan_id = 'plan_180' THEN 6
      WHEN o.plan_id = 'plan_365' THEN 12
      WHEN o.plan_id LIKE 'plan_%' THEN CAST(SUBSTR(o.plan_id, 6) AS INTEGER) / 30
      ELSE 1
    END
  ), 0) as tickets_total
  ...
`).get(tgId);

// СТАЛО:
const ticketsResult = db.prepare(`
  SELECT COALESCE(SUM(${getTicketsFromPlanIdSQL('o.plan_id')}), 0) as tickets_total
  ...
`).get(tgId);
```

3. **Заменить SQL в `getReferralFriends()` (строка ~443-449):**
```typescript
// Аналогично заменить CASE на getTicketsFromPlanIdSQL('o.plan_id')
```

4. **Заменить SQL в `getTicketHistory()` (строка ~557-562):**
```typescript
// Аналогично заменить CASE на getTicketsFromPlanIdSQL('o.plan_id')
```

5. **Заменить SQL в `getAllContestParticipants()` (строка ~773-776):**
```typescript
// Аналогично заменить CASE на getTicketsFromPlanIdSQL('o.plan_id')
```

**Результат:** Одно место изменения вместо 4+

---

## ✅ Задача 2: Исправить fallback логику в getReferralSummary()

### Проблема
Fallback логика не проверяет:
- Окно атрибуции (7 дней)
- Период конкурса (starts_at, ends_at)
- Квалификацию друзей (был ли подписчиком до привязки)

### Решение
Добавить все проверки в fallback логику.

### Шаги

#### Шаг 2.1: Обновить fallback логику в getReferralSummary()

**Файл:** `src/storage/contestRepo.ts`

**Место:** В методе `getReferralSummary()`, блок `else` (строка ~240-278)

**БЫЛО:**
```typescript
} else {
  // Fallback на старую логику, если таблицы еще не созданы
  const stats = db.prepare(`
    SELECT COUNT(*) as invited_total
    FROM bot_db.user_referrals
    WHERE referrer_id = ?
  `).get(tgId);

  const qualifiedCount = db.prepare(`
    SELECT COUNT(DISTINCT ur.referred_id) as qualified_total
    FROM bot_db.user_referrals ur
    JOIN bot_db.orders o ON o.user_id = ur.referred_id
    WHERE ur.referrer_id = ?
      AND o.status IN ('PAID', 'COMPLETED')
  `).get(tgId);

  const ticketsResult = db.prepare(`
    SELECT COALESCE(SUM(${getTicketsFromPlanIdSQL('o.plan_id')}), 0) as tickets_total
    FROM bot_db.orders o
    JOIN bot_db.user_referrals ur ON ur.referred_id = o.user_id
    WHERE ur.referrer_id = ?
      AND o.status IN ('PAID', 'COMPLETED')
  `).get(tgId);
}
```

**СТАЛО:**
```typescript
} else {
  // Fallback на старую логику, если таблицы еще не созданы
  // ВАЖНО: Проверяем окно атрибуции, период конкурса и квалификацию
  
  // Получаем приглашенных друзей за период конкурса
  const stats = db.prepare(`
    SELECT COUNT(DISTINCT ur.referred_id) as invited_total
    FROM bot_db.user_referrals ur
    WHERE ur.referrer_id = ?
      -- Проверка периода конкурса (если есть информация о времени привязки)
      AND (ur.created_at IS NULL 
        OR (ur.created_at >= ? AND ur.created_at <= ?))
  `).get(tgId, contest.starts_at, contest.ends_at);

  // Получаем квалифицированных друзей с проверкой окна атрибуции
  const qualifiedCount = db.prepare(`
    SELECT COUNT(DISTINCT ur.referred_id) as qualified_total
    FROM bot_db.user_referrals ur
    JOIN bot_db.orders o ON o.user_id = ur.referred_id
    WHERE ur.referrer_id = ?
      AND o.status IN ('PAID', 'COMPLETED')
      -- Проверка периода конкурса
      AND o.created_at >= ?
      AND o.created_at <= ?
      -- Проверка окна атрибуции (7 дней от привязки)
      AND o.created_at <= datetime(COALESCE(ur.created_at, o.created_at), '+${contest.attribution_window_days} days')
      -- Проверка квалификации: первый заказ должен быть ПОСЛЕ привязки
      AND NOT EXISTS (
        SELECT 1 FROM bot_db.orders o2
        WHERE o2.user_id = ur.referred_id
          AND o2.status IN ('PAID', 'COMPLETED')
          AND o2.created_at < COALESCE(ur.created_at, o.created_at)
      )
  `).get(tgId, contest.starts_at, contest.ends_at);

  // Получаем билеты с теми же проверками
  const ticketsResult = db.prepare(`
    SELECT COALESCE(SUM(${getTicketsFromPlanIdSQL('o.plan_id')}), 0) as tickets_total
    FROM bot_db.orders o
    JOIN bot_db.user_referrals ur ON ur.referred_id = o.user_id
    WHERE ur.referrer_id = ?
      AND o.status IN ('PAID', 'COMPLETED')
      -- Проверка периода конкурса
      AND o.created_at >= ?
      AND o.created_at <= ?
      -- Проверка окна атрибуции
      AND o.created_at <= datetime(COALESCE(ur.created_at, o.created_at), '+${contest.attribution_window_days} days')
      -- Проверка квалификации
      AND NOT EXISTS (
        SELECT 1 FROM bot_db.orders o2
        WHERE o2.user_id = ur.referred_id
          AND o2.status IN ('PAID', 'COMPLETED')
          AND o2.created_at < COALESCE(ur.created_at, o.created_at)
      )
  `).get(tgId, contest.starts_at, contest.ends_at);

  invitedTotal = stats?.invited_total || 0;
  qualifiedTotal = qualifiedCount?.qualified_total || 0;
  ticketsTotal = ticketsResult?.tickets_total || 0;
}
```

**Важно:** Использовать `COALESCE(ur.created_at, o.created_at)` для совместимости, если `created_at` отсутствует в `user_referrals`.

---

## ✅ Задача 3: Удалить расчет rank/total_participants

### Проблема
В `getReferralSummary()` (строки 283-327) рассчитывается `rank` и `total_participants`, но фронтенд их не использует.

### Решение
Удалить весь блок расчета ранга.

### Шаги

#### Шаг 3.1: Удалить расчет rank и total_participants

**Файл:** `src/storage/contestRepo.ts`

**Место:** В методе `getReferralSummary()`, строки ~283-327

**БЫЛО:**
```typescript
const pendingTotal = invitedTotal - qualifiedTotal;

// Рассчитываем позицию в рейтинге
// Считаем количество участников с большим количеством билетов
let rank: number | null = null;
let totalParticipants: number | null = null;

if (refEventsExists && ticketLedgerExists) {
  // Получаем общее количество участников
  const participantsResult = db.prepare(`
    SELECT COUNT(DISTINCT referrer_id) as total_participants
    FROM bot_db.ticket_ledger
    WHERE contest_id = ?
  `).get(contestId) as { total_participants: number } | undefined;

  totalParticipants = participantsResult?.total_participants || 0;

  // Рассчитываем позицию: сколько участников имеют больше билетов
  if (totalParticipants > 0) {
    // ... сложный расчет с CTE ...
  }
}

return {
  // ...
  rank: rank,  // ❌ Не используется!
  total_participants: totalParticipants,  // ❌ Не используется!
};
```

**СТАЛО:**
```typescript
const pendingTotal = invitedTotal - qualifiedTotal;

// УДАЛЕНО: Расчет rank и total_participants (не используется фронтендом)

return {
  contest: {
    id: contest.id,
    title: contest.title,
    starts_at: contest.starts_at,
    ends_at: contest.ends_at,
    attribution_window_days: contest.attribution_window_days,
    rules_version: contest.rules_version,
    is_active: contest.is_active === 1,
  },
  ref_link: refLink,
  tickets_total: ticketsTotal,
  invited_total: invitedTotal,
  qualified_total: qualifiedTotal,
  pending_total: pendingTotal,
};
```

#### Шаг 3.2: Обновить тип ContestSummary (уже сделано в предыдущих исправлениях)

**Файл:** `src/storage/contestRepo.ts`

Проверить, что тип не содержит `rank` и `total_participants`:

```typescript
export interface ContestSummary {
  contest: Contest;
  ref_link: string;
  tickets_total: number;
  invited_total: number;
  qualified_total: number;
  pending_total: number;
  // ❌ rank и total_participants удалены
}
```

**Результат:** Ускорение ответа API, упрощение кода

---

## ✅ Задача 4: Исправить fallback логику в getReferralFriends()

### Проблема
Fallback логика не проверяет окно атрибуции, период конкурса и квалификацию.

### Решение
Добавить проверки аналогично `getReferralSummary()`.

### Шаги

#### Шаг 4.1: Обновить fallback в getReferralFriends()

**Файл:** `src/storage/contestRepo.ts`

**Место:** В методе `getReferralFriends()`, блок `else` (строка ~422-467)

Добавить проверки в SQL запрос:

```sql
SELECT 
  ur.ROWID as id,
  u.first_name as name,
  u.username as tg_username,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM bot_db.orders o 
      WHERE o.user_id = ur.referred_id 
      AND o.status IN ('PAID', 'COMPLETED')
      -- Добавить проверки:
      AND o.created_at >= ? -- contest.starts_at
      AND o.created_at <= ? -- contest.ends_at
      AND o.created_at <= datetime(COALESCE(ur.created_at, o.created_at), '+7 days')
      AND NOT EXISTS (
        SELECT 1 FROM bot_db.orders o2
        WHERE o2.user_id = ur.referred_id
          AND o2.status IN ('PAID', 'COMPLETED')
          AND o2.created_at < COALESCE(ur.created_at, o.created_at)
      )
    ) THEN 'qualified'
    ELSE 'bound'
  END as status,
  NULL as status_reason,
  (SELECT MIN(created_at) FROM bot_db.orders WHERE user_id = ur.referred_id) as bound_at,
  COALESCE(SUM(${getTicketsFromPlanIdSQL('o.plan_id')}), 0) as tickets_from_friend_total
FROM bot_db.user_referrals ur
LEFT JOIN bot_db.users u ON u.id = ur.referred_id
LEFT JOIN bot_db.orders o ON o.user_id = ur.referred_id 
  AND o.status IN ('PAID', 'COMPLETED')
  -- Добавить проверки в JOIN:
  AND o.created_at >= ? -- contest.starts_at
  AND o.created_at <= ? -- contest.ends_at
  AND o.created_at <= datetime(COALESCE(ur.created_at, o.created_at), '+7 days')
WHERE ur.referrer_id = ?
GROUP BY ur.ROWID, u.first_name, u.username
ORDER BY bound_at DESC
LIMIT ?
```

---

## ✅ Задача 5: Исправить fallback логику в getTicketHistory()

### Проблема
Fallback логика не проверяет окно атрибуции и период конкурса.

### Решение
Добавить проверки.

### Шаги

#### Шаг 5.1: Обновить fallback в getTicketHistory()

**Файл:** `src/storage/contestRepo.ts`

**Место:** В методе `getTicketHistory()`, блок `else` (строка ~550-577)

```sql
SELECT 
  o.id,
  o.created_at,
  ${getTicketsFromPlanIdSQL('o.plan_id')} as delta,
  u.first_name as invitee_name
FROM bot_db.orders o
JOIN bot_db.user_referrals ur ON ur.referred_id = o.user_id
LEFT JOIN bot_db.users u ON u.id = o.user_id
WHERE ur.referrer_id = ?
  AND o.status IN ('PAID', 'COMPLETED')
  -- Добавить проверки:
  AND o.created_at >= ? -- contest.starts_at (нужно передать contestId и получить contest)
  AND o.created_at <= ? -- contest.ends_at
  AND o.created_at <= datetime(COALESCE(ur.created_at, o.created_at), '+7 days')
ORDER BY o.created_at DESC
LIMIT ?
```

**Важно:** Нужно получить `contest` в методе `getTicketHistory()` для проверки периода.

---

## ✅ Задача 6: Вынести проверку таблиц в отдельную функцию

### Проблема
Проверка существования таблиц повторяется в каждом методе.

### Решение
Создать функцию для проверки.

### Шаги

#### Шаг 6.1: Создать функцию проверки таблиц

**Файл:** `src/storage/contestUtils.ts`

```typescript
/**
 * Проверяет существование таблиц для системы конкурсов
 * 
 * @param db - База данных
 * @param dbName - Имя базы (например, 'bot_db')
 * @returns Объект с результатами проверки
 */
export function checkContestTables(
  db: Database.Database,
  dbName: string = 'bot_db'
): { refEventsExists: boolean; ticketLedgerExists: boolean } {
  const refEventsExists = !!db.prepare(`
    SELECT name FROM ${dbName}.sqlite_master 
    WHERE type='table' AND name='ref_events'
  `).get() as { name: string } | undefined;

  const ticketLedgerExists = !!db.prepare(`
    SELECT name FROM ${dbName}.sqlite_master 
    WHERE type='table' AND name='ticket_ledger'
  `).get() as { name: string } | undefined;

  return { refEventsExists, ticketLedgerExists };
}
```

#### Шаг 6.2: Использовать функцию везде

**Файл:** `src/storage/contestRepo.ts`

Заменить во всех методах:

```typescript
// БЫЛО:
const refEventsExists = db.prepare(`
  SELECT name FROM bot_db.sqlite_master 
  WHERE type='table' AND name='ref_events'
`).get() as { name: string } | undefined;

const ticketLedgerExists = db.prepare(`
  SELECT name FROM bot_db.sqlite_master 
  WHERE type='table' AND name='ticket_ledger'
`).get() as { name: string } | undefined;

// СТАЛО:
const { refEventsExists, ticketLedgerExists } = checkContestTables(db, 'bot_db');
```

**Места замены:**
- `getReferralSummary()` - строка ~202-210
- `getReferralFriends()` - строка ~373-382
- `getTicketHistory()` - строка ~518-522
- `getAllContestParticipants()` - строка ~726-731

---

## ✅ Задача 7: Добавить обработку ошибок для ATTACH DATABASE

### Проблема
`ATTACH DATABASE` может провалиться, но нет явной обработки ошибок.

### Решение
Добавить try-catch и логирование.

### Шаги

#### Шаг 7.1: Обернуть ATTACH в try-catch

**Файл:** `src/storage/contestRepo.ts`

Во всех методах добавить:

```typescript
try {
  // Прикрепляем базу бота
  db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
} catch (error) {
  console.error(`[ContestRepo] Failed to attach database: ${botDbPath}`, error);
  if (error instanceof Error) {
    throw new Error(`Failed to attach bot database: ${error.message}`);
  }
  throw error;
}
```

---

## 📊 Чек-лист выполнения

### Высокий приоритет (критично)

- [x] **Задача 1:** Создать `contestUtils.ts` с `getTicketsFromPlanId()` и `getTicketsFromPlanIdSQL()`
- [x] **Задача 1:** Заменить все CASE выражения на `getTicketsFromPlanIdSQL()` в 4+ местах
- [x] **Задача 2:** Исправить fallback логику в `getReferralSummary()` (окно атрибуции, период, квалификация)
- [x] **Задача 3:** Удалить расчет `rank` и `total_participants` из `getReferralSummary()`
- [x] **Задача 4:** Исправить fallback логику в `getReferralFriends()`
- [x] **Задача 5:** Исправить fallback логику в `getTicketHistory()`

### Средний приоритет

- [x] **Задача 6:** Вынести проверку таблиц в `checkContestTables()`
- [x] **Задача 7:** Добавить обработку ошибок для ATTACH DATABASE

### Тестирование

- [ ] Протестировать с новыми таблицами (`ticket_ledger`, `ref_events`)
- [ ] Протестировать fallback логику (без новых таблиц)
- [ ] Проверить, что окно атрибуции работает корректно
- [ ] Проверить, что период конкурса проверяется
- [ ] Проверить, что квалификация друзей работает
- [ ] Проверить производительность (должна улучшиться без расчета rank)

---

## 🎯 Порядок выполнения

### Этап 1: Подготовка (30 минут)
1. Создать `src/storage/contestUtils.ts`
2. Добавить функции `getTicketsFromPlanId()` и `getTicketsFromPlanIdSQL()`
3. Добавить функцию `checkContestTables()`

### Этап 2: Рефакторинг (1 час)
1. Заменить все CASE выражения на `getTicketsFromPlanIdSQL()`
2. Заменить проверки таблиц на `checkContestTables()`

### Этап 3: Исправление fallback (2 часа)
1. Исправить fallback в `getReferralSummary()`
2. Исправить fallback в `getReferralFriends()`
3. Исправить fallback в `getTicketHistory()`

### Этап 4: Очистка (30 минут)
1. Удалить расчет `rank` и `total_participants`
2. Добавить обработку ошибок для ATTACH

### Этап 5: Тестирование (1 час)
1. Тесты с новыми таблицами
2. Тесты fallback логики
3. Проверка производительности

**Общее время:** ~5 часов

---

## 📝 Важные замечания

### 1. Обратная совместимость
- ✅ Fallback логика должна работать, если новых таблиц нет
- ✅ Использовать `COALESCE()` для совместимости со старыми данными

### 2. Производительность
- ⚠️ Добавление проверок может замедлить запросы
- ✅ Добавить индексы на часто используемые поля (если возможно)

### 3. Тестирование
- ✅ Тестировать с реальными данными из БД
- ✅ Проверить граничные случаи (окно атрибуции = 7 дней, период конкурса)

---

## 🎉 Ожидаемые результаты

После выполнения всех задач:

1. ✅ **Единая точка истины** для конвертации plan_id → билеты
2. ✅ **Корректная fallback логика** с проверкой всех требований
3. ✅ **Ускорение API** (удален расчет rank)
4. ✅ **Чистый код** без дублирования
5. ✅ **Надежность** - корректная работа в любом режиме

**Общая оценка качества:** С 5/10 → 9/10 ⭐⭐⭐⭐⭐

---

*План создан на основе анализа в `TICKET_SYSTEM_CRITIQUE.md`*
