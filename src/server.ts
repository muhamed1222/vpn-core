import Fastify from 'fastify';
import dotenv from 'dotenv';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { registerRoutes } from './routes/index.js';
import { SqliteOrderStore } from './store/sqlite-order-store.js';
import { OrderStore } from './store/order-store.js';
import { initDatabase, closeDatabase } from './storage/db.js';
import { YooKassaClient } from './integrations/yookassa/client.js';

// Загружаем переменные окружения
dotenv.config();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3001', 10);
const DATABASE_PATH = process.env.DATABASE_PATH || './data/db.sqlite';
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
const YOOKASSA_RETURN_URL = process.env.YOOKASSA_RETURN_URL || 'https://my.outlivion.space/pay/return';
const YOOKASSA_WEBHOOK_IP_CHECK = process.env.YOOKASSA_WEBHOOK_IP_CHECK === 'true';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://api.outlivion.space';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim())
  : [];

// Telegram auth настройки
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || '';
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'outlivion_session';
const AUTH_COOKIE_DOMAIN = process.env.AUTH_COOKIE_DOMAIN || '.outlivion.space';

const fastify = Fastify({
  logger: true,
  trustProxy: true, // Для корректного определения real IP за nginx
});

// Расширяем типы Fastify для orderStore и yookassaClient
declare module 'fastify' {
  interface FastifyInstance {
    orderStore: OrderStore;
    yookassaClient: YooKassaClient;
    yookassaReturnUrl: string;
    yookassaWebhookIPCheck: boolean;
    publicBaseUrl: string;
    telegramBotToken: string;
    authJwtSecret: string;
    authCookieName: string;
    authCookieDomain: string;
  }
}

// Инициализируем базу данных
initDatabase(DATABASE_PATH);

// Инициализируем хранилище заказов
const orderStore = new SqliteOrderStore();
fastify.decorate('orderStore', orderStore);

// Инициализируем YooKassa клиент
const yookassaClient = new YooKassaClient({
  shopId: YOOKASSA_SHOP_ID,
  secretKey: YOOKASSA_SECRET_KEY,
});
fastify.decorate('yookassaClient', yookassaClient);
fastify.decorate('yookassaReturnUrl', YOOKASSA_RETURN_URL);
fastify.decorate('yookassaWebhookIPCheck', YOOKASSA_WEBHOOK_IP_CHECK);
fastify.decorate('publicBaseUrl', PUBLIC_BASE_URL);
fastify.decorate('telegramBotToken', TELEGRAM_BOT_TOKEN);
fastify.decorate('authJwtSecret', AUTH_JWT_SECRET);
fastify.decorate('authCookieName', AUTH_COOKIE_NAME);
fastify.decorate('authCookieDomain', AUTH_COOKIE_DOMAIN);


// Обработка ошибок
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(error);
  reply.status(error.statusCode || 500).send({
    error: error.message || 'Internal Server Error',
    statusCode: error.statusCode || 500,
  });
});

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  fastify.log.info(`Received ${signal}, closing server...`);
  
  try {
    await fastify.close();
    closeDatabase();
    fastify.log.info('Server closed successfully');
    process.exit(0);
  } catch (error) {
    fastify.log.error({ err: error }, 'Error during shutdown');
    closeDatabase();
    process.exit(1);
  }
};

// Обработка сигналов завершения
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Запуск сервера
const start = async () => {
  try {
    // Регистрируем cookie plugin (нужен для работы с cookies)
    await fastify.register(cookie, {
      secret: AUTH_JWT_SECRET, // Для подписи cookies (опционально)
    });

    // Настройка CORS
    if (ALLOWED_ORIGINS.length > 0) {
      await fastify.register(cors, {
        origin: (origin, callback) => {
          if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
          } else {
            callback(new Error('Not allowed by CORS'), false);
          }
        },
        credentials: true, // Разрешаем отправку cookies
      });
    }

    // Регистрируем роуты (rate-limit настроен внутри v1Routes)
    await registerRoutes(fastify);

    // Выводим список зарегистрированных маршрутов для отладки
    console.log('Registered routes:');
    console.log(fastify.printRoutes());

    await fastify.listen({ host: HOST, port: PORT });
    fastify.log.info(`Server listening on http://${HOST}:${PORT}`);
  } catch (error) {
    fastify.log.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
};

start();

