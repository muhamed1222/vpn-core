# Быстрая синхронизация VPN API на сервер

## Файлы для синхронизации:
1. `src/auth/telegram.ts` (5.1K)
2. `src/auth/telegramPhoto.ts` (1.8K) - **НОВЫЙ ФАЙЛ**
3. `src/routes/v1/auth.ts` (6.7K)

## Команды для выполнения:

### Вариант 1: Использовать скрипт
```bash
cd /Users/kelemetovmuhamed/Documents/vpn-core
./sync_to_server.sh
```

### Вариант 2: Выполнить вручную
```bash
# Копирование файлов
scp src/auth/telegram.ts root@72.56.93.135:/root/vpn-core/src/auth/telegram.ts
scp src/auth/telegramPhoto.ts root@72.56.93.135:/root/vpn-core/src/auth/telegramPhoto.ts
scp src/routes/v1/auth.ts root@72.56.93.135:/root/vpn-core/src/routes/v1/auth.ts

# Перезапуск API на сервере
ssh root@72.56.93.135
cd /root/vpn-core
npm run build
pm2 restart VPN API
pm2 logs VPN API --lines 20
```

## Что изменилось:
- ✅ Добавлено получение фото профиля через Telegram Bot API
- ✅ Все endpoints теперь возвращают `photoUrl`
- ✅ Если фото нет в initData, запрашивается через Bot API

После синхронизации аватарка профиля будет загружаться автоматически!
