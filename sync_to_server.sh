#!/bin/bash
# Скрипт для синхронизации изменений VPN API на сервер

SERVER="root@72.56.93.135"
SERVER_PATH="/root/vpn_api"

echo "📤 Синхронизация файлов VPN API на сервер..."
echo ""

# Файлы для синхронизации
FILES=(
  "src/auth/telegram.ts"
  "src/auth/verifyAuth.ts"
  "src/auth/telegramPhoto.ts"
  "src/integrations/heleket/client.ts"
  "src/routes/v1/auth.ts"
  "src/routes/v1/user.ts"
  "src/routes/v1/payments.ts"
  "src/server.ts"
  "src/integrations/marzban/service.ts"
)

# Копирование файлов
for file in "${FILES[@]}"; do
  echo "📄 Копирование $file..."
  
  # Создаем директорию на сервере, если её нет
  dir=$(dirname "$file")
  ssh "$SERVER" "mkdir -p $SERVER_PATH/$dir"
  
  scp "$file" "$SERVER:$SERVER_PATH/$file"
  if [ $? -eq 0 ]; then
    echo "✅ $file скопирован"
  else
    echo "❌ Ошибка при копировании $file"
    exit 1
  fi
done

echo ""
echo "✅ Все файлы скопированы!"
echo ""
echo "🔄 Перезапуск API на сервере..."
ssh "$SERVER" "cd $SERVER_PATH && npm run build && npx pm2 restart VPN-API && npx pm2 logs VPN-API --lines 10 --nostream"

echo ""
echo "✅ Синхронизация завершена!"
