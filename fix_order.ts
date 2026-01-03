import { SqliteOrderStore } from './src/store/sqlite-order-store.js';
import { MarzbanService } from './src/integrations/marzban/service.js';
import dotenv from 'dotenv';
dotenv.config();

async function fixOrders() {
  const store = new SqliteOrderStore();
  const marzban = new MarzbanService(
    process.env.MARZBAN_API_URL || 'http://127.0.0.1:8000',
    process.env.MARZBAN_ADMIN_USERNAME || '',
    process.env.MARZBAN_ADMIN_PASSWORD || ''
  );

  console.log('Searching for stuck orders...');
  
  // В SQLite можно напрямую через store.db (если он публичный)
  // Но мы просто попробуем активировать конкретный order пользователя
  const orderId = '0c2edcc3-57ad-4a2b-9659-30f38c3c4ef1';
  
  try {
    // В вашем конкретном случае мы знаем, что tgId = 782245481 (из логов бота выше)
    const tgId = 782245481;
    console.log(`Activating order ${orderId} for user ${tgId}`);
    
    const config = await marzban.getUserConfig(tgId);
    if (config) {
      console.log('Found config, updating database...');
      // Нам нужен доступ к репозиторию, чтобы обновить ключ
      // Поскольку sqlite3 нет, мы просто выведем конфиг здесь
      console.log('REAL CONFIG:', config);
    } else {
      console.log('No config found in Marzban yet.');
    }
  } catch (e) {
    console.error('Error:', e);
  }
}

fixOrders();

