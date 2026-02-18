import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import { trackDevice } from '../storage/devicesRepo.js';

// Кеш для дебаунса записи в БД: ключ -> timestamp
const deviceTrackingCache = new Map<string, number>();
const TRACKING_COOLDOWN_MS = 60 * 1000; // 1 минута

// Общий агент с keepAlive для переиспользования соединений
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

// Создаем инстанс axios с агентами
const marzbanClient = axios.create({
    timeout: 10000, // 10 секунд
    httpAgent,
    httpsAgent,
    validateStatus: () => true, // Не бросать ошибку на 404/500
    maxRedirects: 0,
});

export async function subscriptionProxyRoutes(fastify: FastifyInstance) {
    const MARZBAN_URL = process.env.MARZBAN_API_URL || 'http://127.0.0.1:8000';

    // Очистка старого кеша раз в час
    setInterval(() => {
        const now = Date.now();
        for (const [key, time] of deviceTrackingCache.entries()) {
            if (now - time > TRACKING_COOLDOWN_MS * 60) {
                deviceTrackingCache.delete(key);
            }
        }
    }, 3600 * 1000);

    // Основной хендлер
    const handleProxy = async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply, isInfo = false) => {
        const { token } = request.params;
        const userAgent = (request.headers['user-agent'] as string) || 'unknown';
        // Получаем реальный IP
        const ipAddress = (request.headers['x-real-ip'] as string)
            || (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
            || request.ip;

        // 1. Асинхронный трекинг (Fire-and-forget, Debounced)
        try {
            if (token && userAgent && userAgent !== 'unknown') {
                const cacheKey = `${token}:${userAgent}:${ipAddress}`;
                const lastTracked = deviceTrackingCache.get(cacheKey);
                const now = Date.now();

                // Пишем в БД только если прошло время кулдауна, или никогда не писали
                if (!lastTracked || (now - lastTracked > TRACKING_COOLDOWN_MS)) {
                    // Ставим в кеш СРАЗУ, чтобы следующие запросы (через мс) уже отсекались
                    deviceTrackingCache.set(cacheKey, now);

                    // Парсим токен в setImmediate, чтобы не блокировать этот request
                    setImmediate(() => {
                        try {
                            const userRef = extractUserRefFromToken(token);
                            if (userRef) {
                                trackDevice({
                                    userRef,
                                    userAgent,
                                    ipAddress,
                                });
                            }
                        } catch (err: any) {
                            // Тихо игнорируем ошибки
                        }
                    });
                }
            }
        } catch (e) {
            // Игнорируем ошибки трекинга
        }

        // 2. Проксирование (Stream)
        try {
            const targetUrl = `${MARZBAN_URL}/sub/${token}${isInfo ? '/info' : ''}`;

            const response = await marzbanClient.get(targetUrl, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': request.headers['accept'] || '*/*',
                    // Можно добавить Host, если нужно
                    // 'Host': '127.0.0.1:8000' 
                },
                responseType: 'stream' // Важно для производительности
            });

            // Копируем заголовки ответа
            const headersToForward = [
                'content-type',
                'subscription-userinfo',
                'profile-update-interval',
                'profile-title',
                'content-disposition',
                'profile-web-page-url',
                'cache-control',
                'date',
                'etag'
            ];

            for (const header of headersToForward) {
                const value = response.headers[header];
                if (value) {
                    reply.header(header, value);
                }
            }

            // Отправляем поток клиенту
            return reply.status(response.status).send(response.data);

        } catch (err: any) {
            // Логируем только реальные сетевые ошибки
            fastify.log.error({
                err: err.message,
                token: token.substring(0, 10) + '...',
            }, '[SubProxy] Proxy Request Failed');

            return reply.status(502).send('Bad Gateway');
        }
    };

    // GET /sub/:token
    fastify.get<{ Params: { token: string } }>('/sub/:token', (req, rep) => handleProxy(req, rep, false));

    // GET /sub/:token/info
    fastify.get<{ Params: { token: string } }>('/sub/:token/info', (req, rep) => handleProxy(req, rep, true));
}

/**
 * Извлекает user_ref (marzban username) из subscription token.
 * Токен Marzban закодирован в base64url.
 */
function extractUserRefFromToken(token: string): string | null {
    if (!token) return null;
    try {
        // В Marzban токен начинается с base64-строки
        // Берем первые 60 символов, заменяем URL-safe символы и декодируем
        const chunk = token.substring(0, 60).replace(/-/g, '+').replace(/_/g, '/');
        const buffer = Buffer.from(chunk, 'base64');
        const decoded = buffer.toString('utf-8');

        // Ищем паттерн "username," или "tg_123,"
        const match = decoded.match(/([a-zA-Z0-9_]{3,}),\d+/);
        if (match && match[1]) {
            return match[1];
        }

        return null;
    } catch {
        return null;
    }
}
