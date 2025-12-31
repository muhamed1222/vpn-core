# Авторизация через Telegram WebApp

## Описание

Реализована авторизация пользователей через Telegram WebApp (Mini App) с использованием JWT токенов в cookies.

## Переменные окружения

Добавьте в `.env`:

```bash
# Telegram Bot Token (получите у @BotFather)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token

# JWT Secret (минимум 32 символа, рекомендуется случайная строка)
AUTH_JWT_SECRET=your_jwt_secret_min_32_chars_recommended_random_string

# Cookie настройки
AUTH_COOKIE_NAME=outlivion_session
AUTH_COOKIE_DOMAIN=.outlivion.space
```

## API Endpoints

### POST /v1/auth/telegram

Авторизация через Telegram WebApp.

**Request:**
```json
{
  "initData": "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%7D&auth_date=1662771648&hash=c16b5c7c0d0a7b20e7b2e90b5b5e5f5e"
}
```

**Response (200 OK):**
```json
{
  "ok": true,
  "user": {
    "tgId": 279058397,
    "username": "vdkfrost",
    "firstName": "Vladislav"
  }
}
```

**Response (401 Unauthorized):**
```json
{
  "error": "Unauthorized",
  "message": "Invalid initData"
}
```

**Cookie:**
После успешной авторизации устанавливается cookie:
- `name`: `outlivion_session` (или значение `AUTH_COOKIE_NAME`)
- `httpOnly`: `true`
- `secure`: `true` (только HTTPS)
- `sameSite`: `lax`
- `domain`: `.outlivion.space` (или значение `AUTH_COOKIE_DOMAIN`)
- `maxAge`: 7 дней

## Защищенные endpoints

Следующие endpoints требуют авторизации (middleware `verifyAuth`):

### POST /v1/orders/create

**Изменения:**
- Больше не принимает `userRef` из body
- Автоматически берет `userRef` из авторизованного пользователя: `tg_${request.user.tgId}`

**Request:**
```json
{
  "planId": "month"
}
```

**Response (401 Unauthorized):**
```json
{
  "error": "Unauthorized",
  "message": "Authentication required"
}
```

### GET /v1/orders/:orderId

**Изменения:**
- Требует авторизации
- Доступ только владельцу заказа: проверяется, что `order.user_ref == tg_${request.user.tgId}`

**Response (403 Forbidden):**
```json
{
  "error": "Forbidden",
  "message": "Access denied: order belongs to another user"
}
```

## Алгоритм проверки initData

1. Парсит `initData` как querystring
2. Извлекает `hash`
3. Формирует `data_check_string`: все пары кроме `hash`, отсортированные по `key`, склеенные через `\n`
4. Вычисляет `secret_key = HMAC_SHA256("WebAppData", botToken)` (raw bytes)
5. Вычисляет `check_hash = HMAC_SHA256(secret_key, data_check_string)` → hex lowercase
6. Сравнивает с `hash`
7. Проверяет `auth_date` (не старше 24 часов)
8. Извлекает `user` из параметра `user` (JSON строка)

## Использование на фронтенде

### 1. Получение initData

В Telegram WebApp:

```javascript
const tg = window.Telegram.WebApp;
const initData = tg.initData;
```

### 2. Авторизация

```javascript
const response = await fetch('https://api.outlivion.space/v1/auth/telegram', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  credentials: 'include', // Важно для отправки cookies
  body: JSON.stringify({
    initData: tg.initData,
  }),
});

if (response.ok) {
  const data = await response.json();
  console.log('Авторизован:', data.user);
} else {
  console.error('Ошибка авторизации');
}
```

### 3. Создание заказа (с авторизацией)

```javascript
const response = await fetch('https://api.outlivion.space/v1/orders/create', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  credentials: 'include', // Важно для отправки cookies
  body: JSON.stringify({
    planId: 'month',
  }),
});

if (response.ok) {
  const data = await response.json();
  console.log('Заказ создан:', data);
} else if (response.status === 401) {
  console.error('Требуется авторизация');
}
```

## Безопасность

1. **JWT токены** хранятся в `httpOnly` cookies (недоступны из JavaScript)
2. **Cookies** работают только по HTTPS (`secure: true`)
3. **SameSite: lax** защищает от CSRF атак
4. **Проверка initData** гарантирует, что данные пришли от Telegram
5. **Проверка auth_date** предотвращает использование старых токенов
6. **Доступ к заказам** ограничен только владельцу

## Тестирование

### Локальное тестирование

1. Запустите сервер:
```bash
npm run dev
```

2. Установите переменные окружения в `.env`

3. Отправьте тестовый запрос (нужен реальный `initData` от Telegram):
```bash
curl -X POST http://127.0.0.1:3001/v1/auth/telegram \
  -H "Content-Type: application/json" \
  -d '{"initData":"..."}'
```

### Проверка cookie

После успешной авторизации проверьте cookie в браузере:
- DevTools → Application → Cookies → `https://api.outlivion.space`
- Должна быть cookie `outlivion_session`

## Troubleshooting

### Ошибка "Hash verification failed"

- Проверьте, что `TELEGRAM_BOT_TOKEN` правильный
- Убедитесь, что `initData` не был изменен
- Проверьте, что используется правильный алгоритм HMAC-SHA256

### Ошибка "auth_date too old"

- `initData` должен быть получен не более 24 часов назад
- Получите новый `initData` через `window.Telegram.WebApp.initData`

### Cookie не устанавливается

- Проверьте, что используется HTTPS (или `secure: false` для разработки)
- Проверьте `AUTH_COOKIE_DOMAIN` (должен начинаться с точки для поддоменов)
- Убедитесь, что `credentials: 'include'` установлен в fetch запросах

### 401 Unauthorized на защищенных endpoints

- Проверьте, что cookie отправляется с запросом (`credentials: 'include'`)
- Проверьте, что JWT токен не истек (7 дней)
- Проверьте, что `AUTH_JWT_SECRET` правильный


