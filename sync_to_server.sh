#!/bin/bash
# Скрипт для синхронизации изменений vpn-core на сервер

SERVER="root@72.56.93.135"
SERVER_PATH="/root/vpn-core"

echo "📤 Синхронизация файлов vpn-core на сервер..."
echo ""

# Файлы для синхронизации
FILES=(
  "src/auth/telegram.ts"
  "src/auth/telegramPhoto.ts"
  "src/routes/v1/auth.ts"
)

# Копирование файлов
for file in "${FILES[@]}"; do
  echo "📄 Копирование $file..."
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
ssh "$SERVER" "cd $SERVER_PATH && npm run build && pm2 restart vpn-core && pm2 logs vpn-core --lines 10 --nostream"

echo ""
echo "✅ Синхронизация завершена!"
