import { FastifyInstance } from 'fastify';
import { createVerifyAuth } from '../../auth/verifyAuth.js';
import * as repo from '../../storage/promocodesRepo.js';

export async function promoRoutes(fastify: FastifyInstance) {
    const jwtSecret: string = fastify.authJwtSecret;
    const cookieName: string = fastify.authCookieName;
    const adminApiKey: string = fastify.adminApiKey;
    const botDbPath = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';

    const verifyAuth = createVerifyAuth({
        jwtSecret,
        cookieName,
        botToken: fastify.telegramBotToken,
        adminApiKey,
    });

    // POST /v1/promo/validate
    fastify.post<{ Body: { code: string; tgId?: number } }>('/validate', { preHandler: verifyAuth }, async (request, reply) => {
        if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
        const { code, tgId } = request.body;
        if (!code) return reply.status(400).send({ error: 'Missing code' });

        const promo = repo.getPromocode(code, botDbPath);
        if (!promo) {
            return reply.status(404).send({ ok: false, message: 'Промокод не найден или истек' });
        }

        const now = Date.now();
        if (promo.expires_at && promo.expires_at < now) {
            return reply.status(400).send({ ok: false, message: 'Срок действия промокода истек' });
        }

        if (promo.usage_limit && promo.usage_count >= promo.usage_limit) {
            return reply.status(400).send({ ok: false, message: 'Промокод больше не действителен' });
        }

        // Проверяем, не использовал ли уже этот пользователь
        const effectiveTgId = (request.user.isAdmin && tgId) ? tgId : request.user.tgId;

        if (effectiveTgId) {
            const alreadyUsed = repo.hasUserUsedPromocode(effectiveTgId, promo.code, botDbPath);
            if (alreadyUsed) {
                return reply.status(400).send({ ok: false, message: 'Вы уже использовали этот промокод' });
            }
        }

        return reply.send({
            ok: true,
            code: promo.code,
            type: promo.type,
            value: promo.value,
            description: promo.type === 'DISCOUNT' ? `Скидка ${promo.value}%` : `+${promo.value} дней к подписке`
        });
    });

    // POST /v1/promo/apply
    fastify.post<{ Body: { code: string; tgId?: number } }>('/apply', { preHandler: verifyAuth }, async (request, reply) => {
        if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
        const { code, tgId } = request.body;
        if (!code) return reply.status(400).send({ error: 'Missing code' });

        const userId = (request.user.isAdmin && tgId) ? tgId : request.user.tgId;
        if (!userId) return reply.status(400).send({ error: 'Telegram ID is required' });

        const promo = repo.getPromocode(code, botDbPath);
        if (!promo) return reply.status(404).send({ ok: false, message: 'Промокод не найден' });

        const now = Date.now();
        if ((promo.expires_at && promo.expires_at < now) ||
            (promo.usage_limit && promo.usage_count >= promo.usage_limit)) {
            return reply.status(400).send({ ok: false, message: 'Промокод недействителен' });
        }

        if (!request.user.isAdmin) {
            const alreadyUsed = repo.hasUserUsedPromocode(userId, promo.code, botDbPath);
            if (alreadyUsed) return reply.status(400).send({ ok: false, message: 'Промокод уже использован' });
        }

        try {
            if (promo.type === 'DAYS') {
                // Продлеваем через Marzban
                const success = await fastify.marzbanService.renewUser(userId, promo.value);
                if (!success) throw new Error('Marzban renewal failed');

                // Помечаем как использованный
                repo.usePromocode(userId, promo.code, botDbPath);

                return reply.send({ ok: true, message: `Подписка продлена на ${promo.value} дней` });
            } else if (promo.type === 'DISCOUNT') {
                // Устанавливаем персональную скидку на 24 часа
                const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
                repo.setUserDiscount(userId, promo.value, expiresAt, botDbPath);

                // Помечаем как использованный
                repo.usePromocode(userId, promo.code, botDbPath);

                return reply.send({ ok: true, message: `Скидка ${promo.value}% применена на 24 часа` });
            }

            return reply.status(400).send({ ok: false, message: 'Тип промокода не поддерживается' });
        } catch (e) {
            fastify.log.error(e);
            return reply.status(500).send({ ok: false, message: 'Ошибка при применении промокода' });
        }
    });
}
