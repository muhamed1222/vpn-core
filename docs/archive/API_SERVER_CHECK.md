# 🔍 Проверка API сервера для системы розыгрыша

## ✅ Что настроено правильно

### 1. Роуты зарегистрированы
**Файл:** `src/routes/v1/index.ts`

```typescript
✅ contestRoutes зарегистрированы (строка 42-47)
✅ referralRoutes зарегистрированы (строка 50-55)
✅ Обработка ошибок при регистрации роутов
```

**Эндпоинты:**
- ✅ `GET /v1/contest/active` - получение активного конкурса
- ✅ `GET /v1/referral/summary?contest_id={id}` - сводка по конкурсу
- ✅ `GET /v1/referral/friends?contest_id={id}&limit={limit}` - список друзей
- ✅ `GET /v1/referral/tickets?contest_id={id}&limit={limit}` - история билетов

### 2. Валидация и авторизация
**Файл:** `src/routes/v1/contest.ts`, `src/routes/v1/referral.ts`

```typescript
✅ verifyAuth middleware на всех роутах
✅ Проверка Telegram initData
✅ Проверка наличия request.user
```

### 3. Обработка ошибок
**Файл:** `src/storage/contestRepo.ts`

```typescript
✅ Try-catch блоки для всех операций с БД
✅ Логирование ошибок
✅ Graceful fallback при отсутствии таблиц
✅ DETACH DATABASE в finally блоке
```

### 4. Systemd сервис
**Файл:** `deploy/systemd/vpn-core.service`

```typescript
✅ EnvironmentFile=/opt/vpn-core/.env
✅ Restart=always
✅ Правильный WorkingDirectory
```

---

## ⚠️ Что нужно проверить на сервере

### 1. Переменная окружения `BOT_DATABASE_PATH`

**Критично!** Без этой переменной все роуты конкурса возвращают 404.

**Проверка:**
```bash
# На сервере
cd /opt/vpn-core
cat .env | grep BOT_DATABASE_PATH
```

**Должно быть:**
```env
BOT_DATABASE_PATH=/path/to/vpn-bot/data/database.sqlite
```

**Пример правильного пути:**
```env
BOT_DATABASE_PATH=/root/vpn-bot/data/database.sqlite
# или
BOT_DATABASE_PATH=/opt/vpn-bot/data/database.sqlite
```

**Если отсутствует:**
1. Добавить в `/opt/vpn-core/.env`:
   ```env
   BOT_DATABASE_PATH=/root/vpn-bot/data/database.sqlite
   ```
2. Перезапустить сервис:
   ```bash
   sudo systemctl restart VPN API
   ```

---

### 2. Существование базы данных бота

**Проверка:**
```bash
# На сервере
ls -la /root/vpn-bot/data/database.sqlite
# или
ls -la $(grep BOT_DATABASE_PATH /opt/vpn-core/.env | cut -d'=' -f2)
```

**Должно быть:**
- Файл существует
- Права доступа: `-rw-r--r--` (644) или `-rw-rw-r--` (664)
- Владелец: пользователь, от которого запускается API сервис

**Если файл не существует:**
- Проверить путь к базе данных бота
- Убедиться, что бот создал базу данных

---

### 3. Права доступа к базе данных

**Проблема:** API сервер должен иметь права на чтение базы данных бота.

**Проверка:**
```bash
# На сервере
# Узнать пользователя, от которого запускается API
sudo systemctl show VPN API | grep User

# Проверить права
sudo -u outlivion ls -la /root/vpn-bot/data/database.sqlite
```

**Если нет прав:**
```bash
# Вариант 1: Изменить владельца
sudo chown outlivion:outlivion /root/vpn-bot/data/database.sqlite

# Вариант 2: Добавить права чтения для группы
sudo chmod 644 /root/vpn-bot/data/database.sqlite
```

---

### 4. Таблицы в базе данных бота

**Проверка:**
```bash
# На сервере
sqlite3 /root/vpn-bot/data/database.sqlite ".tables" | grep -E "(contests|ref_events|ticket_ledger)"
```

**Должны быть:**
- ✅ `contests` - таблица конкурсов
- ✅ `ref_events` - таблица событий привязки (опционально, есть fallback)
- ✅ `ticket_ledger` - таблица билетов (опционально, есть fallback)

**Если таблиц нет:**
- Запустить скрипт создания конкурса:
  ```bash
  cd /root/vpn-bot
  npx ts-node scripts/create_contest.ts
  ```

---

### 5. Активный конкурс в базе данных

**Проверка:**
```bash
# На сервере
sqlite3 /root/vpn-bot/data/database.sqlite "SELECT id, title, is_active, starts_at, ends_at FROM contests WHERE is_active = 1;"
```

**Должен быть:**
- Хотя бы один конкурс с `is_active = 1`
- `starts_at <= NOW()` и `ends_at >= NOW()` (для активного конкурса)

**Если конкурса нет:**
- Создать конкурс через скрипт:
  ```bash
  cd /root/vpn-bot
  npx ts-node scripts/create_contest.ts \
    --id "contest-2026-01" \
    --title "🎉 Розыгрыш Outlivion — 10 призов!" \
    --start "2026-01-20T00:00:00Z" \
    --end "2026-02-20T23:59:59Z" \
    --window 7 \
    --version "1.0" \
    --active
  ```

---

### 6. Логи API сервера

**Проверка:**
```bash
# На сервере
sudo journalctl -u VPN API -n 100 --no-pager | grep -E "(Contest|Referral|BOT_DATABASE)"
```

**Что искать:**
- ✅ `Contest routes registered` - роуты зарегистрированы
- ✅ `Referral routes registered` - роуты зарегистрированы
- ⚠️ `BOT_DATABASE_PATH not configured` - переменная не установлена
- ⚠️ `Table contests does not exist` - таблица не найдена
- ⚠️ `No active contest found` - нет активного конкурса

---

### 7. Тестовый запрос к API

**Проверка:**
```bash
# На сервере (локально)
curl -X GET "http://localhost:3001/v1/contest/active" \
  -H "Authorization: test" \
  -H "Content-Type: application/json"
```

**Ожидаемый ответ:**
- ✅ `200 OK` с данными конкурса - все работает
- ⚠️ `404 Not Found` с `"Contest system not configured"` - нет `BOT_DATABASE_PATH`
- ⚠️ `404 Not Found` с `"No active contest found"` - нет активного конкурса

---

## 🔧 Чек-лист для проверки на сервере

### Обязательные проверки:

- [ ] **Переменная `BOT_DATABASE_PATH` установлена в `.env`**
  ```bash
  grep BOT_DATABASE_PATH /opt/vpn-core/.env
  ```

- [ ] **База данных бота существует по указанному пути**
  ```bash
  ls -la $(grep BOT_DATABASE_PATH /opt/vpn-core/.env | cut -d'=' -f2)
  ```

- [ ] **API сервер имеет права на чтение базы данных**
  ```bash
  sudo -u outlivion cat $(grep BOT_DATABASE_PATH /opt/vpn-core/.env | cut -d'=' -f2) > /dev/null
  ```

- [ ] **Таблица `contests` существует в базе бота**
  ```bash
  sqlite3 $(grep BOT_DATABASE_PATH /opt/vpn-core/.env | cut -d'=' -f2) ".tables" | grep contests
  ```

- [ ] **Есть активный конкурс в базе данных**
  ```bash
  sqlite3 $(grep BOT_DATABASE_PATH /opt/vpn-core/.env | cut -d'=' -f2) "SELECT COUNT(*) FROM contests WHERE is_active = 1;"
  ```

- [ ] **API сервер перезапущен после изменений**
  ```bash
  sudo systemctl restart VPN API
  sudo systemctl status VPN API
  ```

- [ ] **Роуты конкурса зарегистрированы (проверить логи)**
  ```bash
  sudo journalctl -u VPN API -n 50 | grep -E "(Contest|Referral) routes registered"
  ```

---

## 🐛 Типичные проблемы и решения

### Проблема 1: "Contest system not configured" (404)

**Причина:** `BOT_DATABASE_PATH` не установлена

**Решение:**
```bash
# Добавить в .env
echo "BOT_DATABASE_PATH=/root/vpn-bot/data/database.sqlite" >> /opt/vpn-core/.env

# Перезапустить
sudo systemctl restart VPN API
```

---

### Проблема 2: "No active contest found" (404)

**Причина:** Нет активного конкурса в базе

**Решение:**
```bash
# Создать конкурс
cd /root/vpn-bot
npx ts-node scripts/create_contest.ts --active

# Проверить
sqlite3 /root/vpn-bot/data/database.sqlite "SELECT * FROM contests WHERE is_active = 1;"
```

---

### Проблема 3: "Table contests does not exist" (в логах)

**Причина:** Таблица не создана в базе бота

**Решение:**
```bash
# Проверить структуру базы
sqlite3 /root/vpn-bot/data/database.sqlite ".schema contests"

# Если таблицы нет, перезапустить бота (он создаст таблицы)
sudo systemctl restart VPN Bot
```

---

### Проблема 4: "Permission denied" при чтении базы

**Причина:** Нет прав доступа

**Решение:**
```bash
# Узнать пользователя API
sudo systemctl show VPN API | grep User

# Дать права
sudo chmod 644 /root/vpn-bot/data/database.sqlite
# или
sudo chown outlivion:outlivion /root/vpn-bot/data/database.sqlite
```

---

### Проблема 5: Роуты не зарегистрированы

**Причина:** Ошибка при регистрации роутов

**Решение:**
```bash
# Проверить логи
sudo journalctl -u VPN API -n 100 | grep -i error

# Проверить, что файлы существуют
ls -la /opt/vpn-core/dist/routes/v1/contest.js
ls -la /opt/vpn-core/dist/routes/v1/referral.js

# Пересобрать проект
cd /opt/vpn-core
npm run build
sudo systemctl restart VPN API
```

---

## 📊 Структура ответов API

### GET /v1/contest/active
```json
{
  "contest": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "title": "🎉 Розыгрыш Outlivion — 10 призов!",
    "starts_at": "2026-01-20T00:00:00.000Z",
    "ends_at": "2026-02-20T23:59:59.000Z",
    "attribution_window_days": 7,
    "rules_version": "1.0",
    "is_active": true
  }
}
```

### GET /v1/referral/summary?contest_id={id}
```json
{
  "summary": {
    "contest": { ... },
    "ref_link": "https://t.me/outlivion_bot?start=REF12345678",
    "tickets_total": 12,
    "invited_total": 5,
    "qualified_total": 3,
    "pending_total": 2,
    "rank": 15,
    "total_participants": 100
  }
}
```

---

## ✅ Итоговая проверка

После выполнения всех проверок, убедитесь что:

1. ✅ `BOT_DATABASE_PATH` установлена
2. ✅ База данных доступна
3. ✅ Таблицы существуют
4. ✅ Есть активный конкурс
5. ✅ API сервер перезапущен
6. ✅ Роуты зарегистрированы (в логах)
7. ✅ Тестовый запрос возвращает данные

Если все проверки пройдены - API сервер настроен правильно! 🎉
