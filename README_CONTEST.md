# Настройка конкурсов

## Важно: Перезапуск API сервера

После добавления новых эндпоинтов для конкурсов **необходимо перезапустить API сервер**, чтобы новые роуты заработали.

## Проверка работы

1. Убедитесь, что конкурс создан в базе данных:
   ```bash
   cd VPN Bot
   npx tsx scripts/create_contest.ts
   ```

2. Проверьте, что переменная окружения `BOT_DATABASE_PATH` установлена в API сервере

3. Перезапустите API сервер

4. Проверьте эндпоинт:
   ```bash
   curl -H "Authorization: <initData>" https://api.outlivion.space/v1/contest/active
   ```

## Структура

- `vpn-core/src/routes/v1/contest.ts` - роуты для конкурсов
- `vpn-core/src/routes/v1/referral.ts` - роуты для реферальной программы
- `vpn-core/src/storage/contestRepo.ts` - репозиторий для работы с конкурсами
- `vpn-bot/src/db/sqlite.ts` - таблица contests в базе данных бота
- `vpn-bot/scripts/create_contest.ts` - скрипт для создания конкурса
