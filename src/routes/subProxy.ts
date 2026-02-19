import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import { trackDevice, getActiveDeviceCount, isDeviceRevoked, getDevices } from '../storage/devicesRepo.js';
import { sendNewDeviceNotification } from '../services/notifications.js';

// Mapping for location remarks
const LOCATION_MAPPING: Record<string, string> = {
    'NL': 'Нидерланды',
    'Netherlands': 'Нидерланды',
    'DE': 'Германия',
    'Germany': 'Германия',
    'KZ': 'Казахстан',
    'Kazakhstan': 'Казахстан',
    'Marz': 'Нидерланды (Premium)'
};

const FLAG_MAPPING: Record<string, string> = {
    'Нидерланды': '🇳🇱',
    'Германия': '🇩🇪',
    'Казахстан': '🇰🇿'
};

function transformContent(content: string): string {
    try {
        let isBase64 = false;
        let decoded = content;

        if (/^[A-Za-z0-9+/=]+$/.test(content.trim())) {
            try {
                decoded = Buffer.from(content.trim(), 'base64').toString('utf-8');
                isBase64 = true;
            } catch {
                decoded = content;
            }
        }

        // Разбиваем на строки и обрабатываем каждую ссылку отдельно
        const lines = decoded.split('\n');
        const transformedLines = lines.map(line => {
            if (!line.includes('#')) return line;

            let [url, remark] = line.split('#');
            if (!remark) return line;

            // Декодируем, чтобы убрать %F0%9F... и прочее
            try {
                remark = decodeURIComponent(remark);
            } catch (e) {
                // ignore
            }

            // 1. Убираем всё в круглых () и квадратных [] скобках
            remark = remark.replace(/\s*\(.*?\)/g, '');
            remark = remark.replace(/\s*\[.*?\]/g, '');

            // 2. Убираем существующие флаги и эмодзи в начале
            remark = remark.replace(/^[\s\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');

            // Чистим от лишних дефисов и пробелов в начале
            remark = remark.replace(/^[\s\-_]+/g, '');

            // 3. Заменяем технические названия на русские
            for (const [key, value] of Object.entries(LOCATION_MAPPING)) {
                // Используем границы слов и учитываем регистр для коротких кодов (NL, DE, KZ)
                const isShortCode = key.length <= 2;
                const regex = new RegExp(`(^|[^a-zA-Z])${key}([^a-zA-Z]|$)`, isShortCode ? 'g' : 'gi');

                if (regex.test(remark)) {
                    remark = value;
                    break;
                }
            }

            // 4. Добавляем флаг
            let flag = '🚀';
            for (const [name, f] of Object.entries(FLAG_MAPPING)) {
                if (remark.includes(name)) {
                    flag = f;
                    break;
                }
            }

            const finalRemark = `${flag} ${remark}`.trim();

            return `${url}#${finalRemark}`;
        });

        const transformed = transformedLines.join('\n');

        if (isBase64) {
            return Buffer.from(transformed).toString('base64');
        }
        return transformed;
    } catch (e) {
        return content;
    }
}

// ... rest of the subProxy logic (caching, tracking) remains same ...

interface CacheEntry {
    timestamp: number;
    allowed: boolean;
    reason?: string;
}
const deviceTrackingCache = new Map<string, CacheEntry>();
const TRACKING_COOLDOWN_MS = 60 * 1000;
const geoIpCache = new Map<string, string>();

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const marzbanClient = axios.create({
    timeout: 10000,
    httpAgent,
    httpsAgent,
    validateStatus: () => true,
    maxRedirects: 0,
});

async function getCountry(ip: string): Promise<string | null> {
    if (geoIpCache.has(ip)) return geoIpCache.get(ip)!;
    try {
        const res = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country`, { timeout: 2000 });
        if (res.data?.status === 'success') {
            geoIpCache.set(ip, res.data.country);
            return res.data.country;
        }
    } catch { }
    return null;
}

export async function subscriptionProxyRoutes(fastify: FastifyInstance) {
    const MARZBAN_URL = process.env.MARZBAN_API_URL || 'http://127.0.0.1:8000';

    const handleProxy = async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply, isInfo = false) => {
        const { token } = request.params;
        const userAgent = (request.headers['user-agent'] as string) || 'unknown';
        const ipAddress = (request.headers['x-real-ip'] as string) || request.ip;

        const userRef = extractUserRefFromToken(token);
        fastify.log.info({ userRef, token: token.substring(0, 10), userAgent }, '[SubProxy] Incoming request');

        if (userRef) {
            const deviceId = `${userAgent}|${ipAddress}`;
            if (isDeviceRevoked(userRef, deviceId)) return reply.status(403).send('Device Revoked');

            // Track asyncly
            setImmediate(async () => {
                const country = await getCountry(ipAddress);
                trackDevice({ userRef, userAgent, ip: ipAddress, country: country || undefined });
            });
        }

        try {
            const queryString = new URLSearchParams(request.query as any).toString();
            const targetUrl = `${MARZBAN_URL}/sub/${token}${isInfo ? '/info' : ''}${queryString ? '?' + queryString : ''}`;

            // For character transformation, we might need the body as text, not stream
            // but only if we are not expecting massive files (subs are usually < 100kb)
            const response = await marzbanClient.get(targetUrl, {
                headers: {
                    'User-Agent': userAgent,
                    'Host': 'vpn.outlivion.space',
                    'X-Forwarded-Proto': 'https',
                },
                responseType: 'arraybuffer' // Get as buffer to handle encoding properly
            });

            // Forward headers
            for (const [key, value] of Object.entries(response.headers)) {
                if (['content-length', 'transfer-encoding', 'content-encoding', 'connection'].includes(key.toLowerCase())) continue;
                reply.header(key, value);
            }

            // Fallback Branding
            if (!response.headers['profile-title']) reply.header('Profile-Title', 'Outlivian VPN');
            if (!response.headers['profile-web-page-url']) reply.header('Profile-Web-Page-Url', 'https://t.me/OutlivionBot');

            // Transform Body
            const body = Buffer.from(response.data).toString('utf8');
            const transformedBody = transformContent(body);

            return reply.status(response.status).send(transformedBody);

        } catch (err: any) {
            return reply.status(502).send('Bad Gateway');
        }
    };

    fastify.get<{ Params: { token: string } }>('/sub/:token', (req, rep) => handleProxy(req, rep, false));
    fastify.get<{ Params: { token: string } }>('/sub/:token/info', (req, rep) => handleProxy(req, rep, true));
}

function extractUserRefFromToken(token: string): string | null {
    if (!token) return null;
    try {
        const parts = token.split('.');
        if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
            if (payload.sub?.startsWith('tg_')) return payload.sub;
        }
        const match = Buffer.from(token.substring(0, 100), 'base64').toString().match(/(tg_\d+)/);
        return match?.[1] || null;
    } catch { return null; }
}
