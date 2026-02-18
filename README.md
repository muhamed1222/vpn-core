# 🚀 Outlivion VPN API

Backend API для VPN сервиса Outlivion с интеграцией Telegram бота, платежных систем и конкурсной механики.

---

## 📚 Документация

### 🏠 Центральная документация (main source of truth):
**→ [`Outlivion baza/docs/`](../docs/README.md)**
- [`01-overview.md`](../docs/01-overview.md) - обзор всех компонентов
- [`02-architecture.md`](../docs/02-architecture.md) - архитектура системы
- [`03-flows/`](../docs/03-flows/) - потоки данных и процессы
- [`04-apis/`](../docs/04-apis/) - API спецификации

### 📁 Локальная документация (специфика VPN API):

1. **[CONTEST_API.md](../docs/08-services/vpn-core/CONTEST_API.md)**  
   API для конкурсной системы

2. **[README_CONTEST.md](../docs/08-services/vpn-core/README_CONTEST.md)**  
   Документация конкурсной механики

3. **[ADMIN_API_KEY_SETUP.md](../docs/08-services/vpn-core/ADMIN_API_KEY_SETUP.md)**  
   Настройка административного доступа

4. **[DATABASE_MIGRATION_PLAN.md](../docs/08-services/vpn-core/DATABASE_MIGRATION_PLAN.md)**  
   План миграции базы данных

5. **[TECHNICAL_SPEC.md](../docs/08-services/vpn-core/TECHNICAL_SPEC.md)**  
   Техническая спецификация (может быть устаревшей, см. центральную docs/)

### 📦 Архив:
Старые отчеты находятся в `docs/archive/`

---

## 🎯 Основные функции

### 💳 Платежная система
- ✅ Telegram Stars (встроенные платежи Telegram)
- ✅ YooKassa (банковские карты, электронные кошельки)
- ✅ Автоматическая обработка платежей
- ✅ Webhook обработчики

### 🎟️ Конкурсная механика
- ✅ Автоматическое начисление билетов за покупки
- ✅ Промокоды и реферальная система
- ✅ Розыгрыши призов
- ✅ Статистика участников

### 🔐 VPN управление
- ✅ Интеграция с Marzban
- ✅ Автоматическое создание пользователей
- ✅ Управление подписками
- ✅ VLESS ключи

### 👨‍💼 Административная панель
- ✅ Управление пользователями
- ✅ Статистика платежей
- ✅ Управление конкурсами
- ✅ Мониторинг системы

---

## 🛠️ Технологии

- **Backend:** Fastify, TypeScript
- **Database:** better-sqlite3
- **VPN:** Marzban API
- **Payments:** YooKassa, Telegram Stars
- **Bot:** Telegraf (отдельный репозиторий)

---

## 🚀 Быстрый старт

### Установка:
```bash
npm install
```

### Настройка .env:
```bash
# API
PORT=3001
NODE_ENV=production

# Database
BOT_DATABASE_PATH=/root/vpn-bot/data/database.sqlite

# YooKassa
YOOKASSA_SHOP_ID=your_shop_id
YOOKASSA_SECRET_KEY=your_secret_key

# Marzban
MARZBAN_API_URL=http://127.0.0.1:8000
MARZBAN_ADMIN_USERNAME=admin
MARZBAN_ADMIN_PASSWORD=your_password

# Admin
ADMIN_API_KEY=your_secure_key
ADMIN_USER_IDS=123456789,987654321
```

### Запуск:
```bash
# Development
npm run dev

# Production
npm run build
npm start
```

---

## 📊 API Endpoints

### Публичные:
- `GET /v1/subscription/:userId` - Информация о подписке
- `POST /v1/payments/webhook` - YooKassa webhook

### Административные:
- `GET /v1/admin/contest/:contestId/participants` - Участники конкурса
- `GET /v1/admin/award-retry-stats` - Статистика начисления билетов

Полная документация: [CONTEST_API.md](../docs/08-services/vpn-core/CONTEST_API.md)

---

## 🏗️ Архитектура

```
┌─────────────────────────────────────────────────────┐
│              ПОЛЬЗОВАТЕЛЬ                           │
└─────────────────┬───────────────────────────────────┘
                  │
         ┌────────┴────────┐
         │                 │
         ▼                 ▼
┌─────────────┐   ┌──────────────┐
│  Telegram   │   │   YooKassa   │
│   Stars     │   │  (Webhook)   │
└──────┬──────┘   └──────┬───────┘
       │                 │
       ▼                 ▼
┌────────────────────────────────────┐
│         VPN BOT (Express)          │
│  - Telegram Bot (Telegraf)         │
│  - Webhook Handler                 │
└────────┬───────────────────────────┘
         │
         ▼
┌────────────────────────────────────┐
│        VPN API (Fastify)           │
│  - Contest System                  │
│  - Subscription Management         │
└────────┬───────────────────────────┘
         │
         ▼
┌────────────────────────────────────┐
│     Marzban API (VPN Service)      │
│  - User Management                 │
│  - VLESS Keys                      │
└────────────────────────────────────┘
```

---

## 📈 Статус

### ✅ Работает автоматически:
- Прием платежей (Stars + YooKassa)
- Продление подписок
- Выдача VPN ключей
- Начисление билетов в конкурс
- Уведомления пользователей

### 🔄 В разработке:
- Расширенная аналитика
- Дополнительные платежные системы
- Маркетинговые автоматизации

---

## 📞 Контакты

- **Telegram Bot:** @Outlivion VPN_bot
- **Website:** https://my.outlivion.space
- **VPN Domain:** https://vpn.outlivion.space

---

## 📝 Лицензия

Proprietary - Все права защищены © 2025 Outlivion
