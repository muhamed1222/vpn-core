# Инструкция по синхронизации изменений VPN API на сервер

## Изменения
1. **src/auth/telegram.ts** - добавлен `photo_url` в интерфейс `TelegramUser`
2. **src/auth/telegramPhoto.ts** - новый файл с функцией `getUserPhotoUrl` для получения фото через Bot API
3. **src/routes/v1/auth.ts** - обновлены все endpoints для получения фото профиля через Bot API

## Команды для синхронизации

### 1. Копирование файлов на сервер (локально):
```bash
scp src/auth/telegram.ts root@72.56.93.135:/root/vpn-core/src/auth/telegram.ts
scp src/auth/telegramPhoto.ts root@72.56.93.135:/root/vpn-core/src/auth/telegramPhoto.ts
scp src/routes/v1/auth.ts root@72.56.93.135:/root/vpn-core/src/routes/v1/auth.ts
```

### 2. Перезапуск API на сервере:
```bash
ssh root@72.56.93.135
cd /root/vpn-core
npm run build
pm2 restart VPN API
```

Или если pm2 не установлен:
```bash
pkill -f 'node.*server'
npm start &
```

## Проверка
После перезапуска проверьте логи:
```bash
pm2 logs VPN API --lines 20
```

Или проверьте, что API отвечает:
```bash
curl https://api.outlivion.space/v1/auth/me
```
