# Почему Vercel сайт может не получить данные сразу

**Вопрос:** Значит Vercel сайт не может получить данные о билетах сразу после начисления?

**Ответ:** ✅ **Данные ДОЛЖНЫ приходить мгновенно, НО могут быть задержки из-за кеширования**

---

## Архитектура получения данных

### Поток данных от начисления до отображения

```
┌────────────────────────────────────────────────────────────────┐
│ 1. НАЧИСЛЕНИЕ БИЛЕТОВ (Backend)                                │
│    Файл: vpn-core/src/storage/contestUtils.ts                  │
│    ↓                                                            │
│    INSERT INTO ticket_ledger (...) ← Запись в SQLite БД        │
│    Время: < 100ms                                              │
└────────────────────────────────────────────────────────────────┘
                               ↓
┌────────────────────────────────────────────────────────────────┐
│ 2. ЗАПРОС С ФРОНТЕНДА (Vercel Next.js)                        │
│    Файл: vpn-tg-app/app/(auth)/contest/page.tsx               │
│    ↓                                                            │
│    fetch('/api/referral/tickets?contest_id=...')               │
│    Время: зависит от кеша                                      │
└────────────────────────────────────────────────────────────────┘
                               ↓
┌────────────────────────────────────────────────────────────────┐
│ 3. NEXT.JS API ROUTE (Vercel Edge)                            │
│    Файл: vpn-tg-app/app/api/referral/tickets/route.ts         │
│    ↓                                                            │
│    Проксирует на: https://my.outlivion.space/v1/referral/...  │
│    Время: 10-50ms                                              │
└────────────────────────────────────────────────────────────────┘
                               ↓
┌────────────────────────────────────────────────────────────────┐
│ 4. BACKEND API (VPN API)                                       │
│    Файл: vpn-core/src/routes/v1/referral.ts                    │
│    ↓                                                            │
│    SELECT * FROM ticket_ledger WHERE tg_id = ... ← Чтение БД  │
│    Время: 10-50ms                                              │
└────────────────────────────────────────────────────────────────┘
                               ↓
┌────────────────────────────────────────────────────────────────┐
│ 5. ОТВЕТ ВОЗВРАЩАЕТСЯ ОБРАТНО                                 │
│    Backend → Next.js → Browser → UI                           │
│    Время: 50-200ms                                             │
└────────────────────────────────────────────────────────────────┘
```

**Итоговое время (без кеша):** ~100-400ms ✅

**С кешем:** может быть задержка до обновления кеша ⚠️

---

## Проверенные места: НЕТ кеширования

### ✅ Backend API (`/v1/referral/tickets`)

**Файл:** `vpn-core/src/routes/v1/referral.ts` (строки 107-141)

```typescript
fastify.get('/tickets', { preHandler: verifyAuth }, async (request, reply) => {
  const tickets = getTicketHistory(
    request.user.tgId,
    contest_id,
    limitNum,
    botDbPath
  );
  
  return reply.send({ tickets }); // ← НЕТ Cache-Control заголовков
});
```

**Результат:** ❌ НЕТ кеширования на уровне backend

---

### ✅ Frontend API Route (`/api/referral/tickets`)

**Файл:** `vpn-tg-app/app/api/referral/tickets/route.ts` (строки 1-52)

```typescript
export async function GET(request: NextRequest) {
  // Проксируем запрос на бэкенд API
  const response = await proxyGet(request, '/v1/referral/tickets', {
    requireAuth: true,
    queryParams: { contest_id: contestId },
  });
  
  return NextResponse.json({ ok: true, tickets: data.tickets || [] });
  // ← НЕТ Cache-Control заголовков
}
```

**Результат:** ❌ НЕТ кеширования на уровне Next.js API

---

### ✅ Frontend Page (`/contest`)

**Файл:** `vpn-tg-app/app/(auth)/contest/page.tsx` (строки 1-390)

```typescript
'use client'; // ← Client Component (рендерится на клиенте)

export default function ContestPage() {
  const loadContestData = useCallback(async () => {
    const ticketsResponse = await fetch(
      `/api/referral/tickets?contest_id=${contestId}&limit=20`,
      { headers } // ← НЕТ cache: 'no-store'
    );
    
    const ticketsData = await ticketsResponse.json();
    setTickets(ticketsData.tickets || []);
  }, []);
  
  useEffect(() => {
    loadContestData();
  }, [loadContestData]);
}
```

**Результат:** ❌ НЕТ явного кеширования, но может использоваться браузерный кеш

---

## Где МОЖЕТ быть кеширование

### ⚠️ 1. Vercel Edge Network (CDN)

**Проблема:**
- Vercel может автоматически кешировать GET запросы
- Даже без явных Cache-Control заголовков
- Особенно для `/api/*` routes

**Решение:**
```typescript
// В app/api/referral/tickets/route.ts
export async function GET(request: NextRequest) {
  const response = await proxyGet(...);
  
  // ✅ ДОБАВИТЬ явный запрет кеширования
  return new NextResponse(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}
```

---

### ⚠️ 2. Browser Cache (кеш браузера)

**Проблема:**
- Браузер может кешировать ответы API
- Если нет явных заголовков `Cache-Control`
- Telegram WebView может агрессивнее кешировать

**Решение:**
```typescript
// В app/(auth)/contest/page.tsx
const ticketsResponse = await fetch(
  `/api/referral/tickets?contest_id=${contestId}&limit=20`,
  { 
    headers,
    cache: 'no-store', // ✅ ДОБАВИТЬ для Next.js fetch
  }
);
```

---

### ⚠️ 3. Telegram WebApp Cache

**Проблема:**
- Telegram Mini App может кешировать ресурсы
- Особенно статические файлы и API ответы
- Может игнорировать некоторые Cache-Control заголовки

**Решение:**
```typescript
// Добавить timestamp или random query parameter
const ticketsResponse = await fetch(
  `/api/referral/tickets?contest_id=${contestId}&limit=20&t=${Date.now()}`,
  { headers }
);
```

---

### ⚠️ 4. SWR/React Query (если используется)

**Проверка:**
```bash
# Проверить, используется ли SWR или React Query
cd /Users/kelemetovmuhamed/Documents/Outlivion\ baza/vpn-tg-app
grep -r "useSWR\|useQuery" app/ hooks/
```

**Результат:** НЕТ использования SWR/React Query ✅

---

## Рекомендуемое решение

### 1. Добавить запрет кеширования на уровне API

**Файл:** `vpn-tg-app/app/api/referral/tickets/route.ts`

```typescript
export async function GET(request: NextRequest) {
  const validationError = validateApiRequest(request, true);
  if (validationError) return validationError;

  const { searchParams } = new URL(request.url);
  const contestId = searchParams.get('contest_id');

  if (!contestId) {
    return NextResponse.json(
      { error: 'Missing contest_id parameter' },
      { status: 400 }
    );
  }

  const response = await proxyGet(request, '/v1/referral/tickets', {
    requireAuth: true,
    queryParams: { contest_id: contestId },
    logContext: {
      page: 'api',
      action: 'getReferralTickets',
      endpoint: '/api/referral/tickets',
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return NextResponse.json(
      { 
        ok: false, 
        tickets: [], 
        error: data.error || 'Не удалось загрузить историю билетов. Попробуйте позже.' 
      },
      { 
        status: response.status,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      }
    );
  }

  const data = await response.json().catch(() => ({}));
  
  // ✅ ДОБАВИТЬ запрет кеширования
  return new NextResponse(
    JSON.stringify({ ok: true, tickets: data.tickets || [] }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    }
  );
}
```

---

### 2. Добавить `cache: 'no-store'` на фронтенде

**Файл:** `vpn-tg-app/app/(auth)/contest/page.tsx`

```typescript
// Внутри loadContestData()
const [summaryResponse, friendsResponse, ticketsResponse] = await Promise.all([
  fetch(`/api/referral/summary?contest_id=${contestId}`, { 
    headers,
    cache: 'no-store', // ✅ ДОБАВИТЬ
  }).catch(() => null),
  
  fetch(`/api/referral/friends?contest_id=${contestId}&limit=50`, { 
    headers,
    cache: 'no-store', // ✅ ДОБАВИТЬ
  }).catch(() => null),
  
  fetch(`/api/referral/tickets?contest_id=${contestId}&limit=20`, { 
    headers,
    cache: 'no-store', // ✅ ДОБАВИТЬ
  }).catch(() => null),
]);
```

---

### 3. Добавить динамический query параметр (альтернатива)

**Файл:** `vpn-tg-app/app/(auth)/contest/page.tsx`

```typescript
// Добавить timestamp для предотвращения кеширования
const timestamp = Date.now();

const ticketsResponse = await fetch(
  `/api/referral/tickets?contest_id=${contestId}&limit=20&_t=${timestamp}`,
  { headers }
).catch(() => null);
```

---

## Как проверить текущее кеширование

### 1. Проверить заголовки ответа API

```bash
# Получить initData из Telegram Mini App (через DevTools Console)
window.Telegram.WebApp.initData

# Сделать запрос к API с заголовками
curl -v \
  -H "X-Telegram-Init-Data: query_id=..." \
  https://vpn-website-gamma.vercel.app/api/referral/tickets?contest_id=550e8400-e29b-41d4-a716-446655440000

# Посмотреть на заголовки ответа
# Искать: Cache-Control, Pragma, Expires
```

**Ожидаемый результат (СЕЙЧАС):**
```
< HTTP/2 200
< content-type: application/json
< ... (НЕТ Cache-Control) ← ПРОБЛЕМА!
```

**Ожидаемый результат (ПОСЛЕ ИСПРАВЛЕНИЯ):**
```
< HTTP/2 200
< content-type: application/json
< cache-control: no-store, no-cache, must-revalidate, max-age=0
< pragma: no-cache
< expires: 0
```

---

### 2. Проверить через DevTools

1. Открыть Telegram Mini App в браузере (не в Telegram)
2. Открыть DevTools (F12) → Network tab
3. Обновить страницу конкурса
4. Найти запрос к `/api/referral/tickets`
5. Посмотреть Response Headers:
   - **Если есть `from disk cache` или `from memory cache`** → кеш работает ❌
   - **Если `Status: 200` и нет упоминания cache** → запрос свежий ✅

---

### 3. Проверить Vercel Edge Caching

```bash
# Проверить заголовки через curl
curl -I https://vpn-website-gamma.vercel.app/api/referral/tickets?contest_id=550e8400-e29b-41d4-a716-446655440000

# Искать заголовки:
# - x-vercel-cache: HIT ← кеш сработал ❌
# - x-vercel-cache: MISS ← кеш НЕ сработал ✅
# - x-vercel-cache: BYPASS ← кеш отключен ✅
```

---

## Итоговый ответ

### Вопрос: Значит Vercel сайт не может получить данные сразу?

### Ответ: Данные ДОЛЖНЫ приходить сразу, НО есть проблема:

**Текущая ситуация:**
1. ❌ API routes НЕ отправляют заголовки `Cache-Control: no-store`
2. ❌ Frontend НЕ использует `cache: 'no-store'` в fetch
3. ⚠️ Vercel Edge Network может кешировать ответы
4. ⚠️ Браузер/Telegram может кешировать ответы

**Что происходит:**
```
Пользователь покупает → Билеты начисляются (мгновенно) →
Пользователь обновляет страницу → Запрос идет в кеш (старые данные) ❌
```

**Что должно происходить:**
```
Пользователь покупает → Билеты начисляются (мгновенно) →
Пользователь обновляет страницу → Запрос идет в БД (новые данные) ✅
```

---

## Рекомендации

### Критично (нужно исправить):
1. ✅ **Добавить Cache-Control в `/api/referral/tickets`**
2. ✅ **Добавить Cache-Control в `/api/referral/summary`**
3. ✅ **Добавить Cache-Control в `/api/referral/friends`**
4. ✅ **Добавить `cache: 'no-store'` в fetch на странице**

### Опционально (для дополнительной защиты):
5. ⚠️ **Добавить timestamp в query параметры**
6. ⚠️ **Добавить кнопку "Обновить" на странице конкурса**

---

## Следующие шаги

Хотите, чтобы я:
1. ✅ **Добавил запрет кеширования во все API routes?**
2. ✅ **Добавил `cache: 'no-store'` на страницу конкурса?**
3. ✅ **Проверил текущие заголовки на production?**
