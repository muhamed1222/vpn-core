import { FastifyInstance } from 'fastify';
import axios from 'axios';
import { trackDevice } from '../storage/devicesRepo.js';

/**
 * Subscription Proxy
 * 
 * Перехватывает запросы к /sub/:token от VPN-клиентов.
 * 1. Логирует user-agent, IP, timestamp → SQLite (device_connections)
 * 2. Проксирует запрос в Marzban и возвращает оригинальный ответ
 * 
 * Токен в URL содержит base64 username: dGdfOTc4ODU1NTE2... → tg_978855516,...
 */
export async function subscriptionProxyRoutes(fastify: FastifyInstance) {
    const MARZBAN_URL = process.env.MARZBAN_API_URL || 'http://127.0.0.1:8000';

    // GET /sub/:token — основной subscription endpoint
    fastify.get<{ Params: { token: string } }>('/sub/:token', async (request, reply) => {
        const { token } = request.params;
        const userAgent = request.headers['user-agent'] || 'unknown';
        const ipAddress = (request.headers['x-real-ip'] as string)
            || (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
            || request.ip;

        // 1. Извлекаем username из токена (base64 decode)
        const userRef = extractUserRefFromToken(token);

        // 2. Логируем устройство (async, не блокирует ответ)
        if (userRef && userAgent !== 'unknown') {
            try {
                trackDevice({
                    userRef,
                    userAgent,
                    ipAddress,
                });
                fastify.log.info({
                    userRef,
                    userAgent,
                    ipAddress,
                }, '[SubProxy] Device tracked');
            } catch (err: any) {
                fastify.log.warn({ err: err.message, userRef }, '[SubProxy] Failed to track device');
            }
        }

        // 3. Проксируем запрос к Marzban
        try {
            const marzbanResp = await axios.get(`${MARZBAN_URL}/sub/${token}`, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': request.headers['accept'] || '*/*',
                },
                responseType: 'text',
                timeout: 15000,
                validateStatus: () => true, // Принимаем любой HTTP-статус
            });

            // Копируем заголовки ответа Marzban
            const headersToForward = [
                'content-type',
                'subscription-userinfo',
                'profile-update-interval',
                'profile-title',
                'content-disposition',
                'profile-web-page-url',
            ];

            for (const header of headersToForward) {
                const value = marzbanResp.headers[header];
                if (value) {
                    reply.header(header, value);
                }
            }

            return reply.status(marzbanResp.status).send(marzbanResp.data);
        } catch (err: any) {
            fastify.log.error({ err: err.message, token: token.substring(0, 10) + '...' }, '[SubProxy] Marzban proxy failed');
            return reply.status(502).send('Bad Gateway');
        }
    });

    // GET /sub/:token/info — некоторые клиенты запрашивают доп. инфо
    fastify.get<{ Params: { token: string } }>('/sub/:token/info', async (request, reply) => {
        const { token } = request.params;
        try {
            const marzbanResp = await axios.get(`${MARZBAN_URL}/sub/${token}/info`, {
                headers: { 'User-Agent': request.headers['user-agent'] || '' },
                responseType: 'text',
                timeout: 15000,
                validateStatus: () => true,
            });

            const contentType = marzbanResp.headers['content-type'];
            if (contentType) reply.header('content-type', contentType);

            return reply.status(marzbanResp.status).send(marzbanResp.data);
        } catch (err: any) {
            return reply.status(502).send('Bad Gateway');
        }
    });
}

/**
 * Извлекает user_ref (marzban username) из subscription token.
 * 
 * Формат Marzban-токена: base64(username,timestamp) + random suffix
 * Пример: dGdfOTc4ODU1NTE2LDE3NzExNDc3MzE8x7xAzvZbH
 *   → decode → tg_978855516,1771147731
 *   → userRef = tg_978855516
 */
function extractUserRefFromToken(token: string): string | null {
    try {
        // Marzban token = base64url(username,timestamp) + random chars
        // Пробуем разные длины base64 (кратные 4, с padding)
        for (let len = token.length; len >= 20; len--) {
            const candidate = token.substring(0, len);
            try {
                // Заменяем URL-safe символы
                const base64 = candidate.replace(/-/g, '+').replace(/_/g, '/');
                const decoded = Buffer.from(base64, 'base64').toString('utf-8');

                // Проверяем формат: username,timestamp
                if (decoded.includes(',') && (decoded.startsWith('tg_') || /^[a-zA-Z0-9_]+,\d+$/.test(decoded))) {
                    const username = decoded.split(',')[0];
                    if (username && username.length > 2) {
                        return username;
                    }
                }
            } catch {
                continue;
            }
        }
        return null;
    } catch {
        return null;
    }
}
