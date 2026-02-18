import * as fs from 'fs';
import * as path from 'path';
import { trackDevice } from '../storage/devicesRepo.js';

const LOG_FILE_PATH = '/var/log/nginx/marzban.access.log';
// Интервал проверки файла (поллинг) - 5 секунд
const CHECK_INTERVAL_MS = 5000;

let currentSize = 0;
let isWatching = false;

export function startLogWatcher() {
    if (isWatching) return;

    // Проверяем существование файла
    if (!fs.existsSync(LOG_FILE_PATH)) {
        console.warn(`[LogWatcher] Log file not found: ${LOG_FILE_PATH}. Device tracking disabled.`);
        return;
    }

    // Начинаем с конца файла
    try {
        const stats = fs.statSync(LOG_FILE_PATH);
        currentSize = stats.size;
    } catch (e) {
        console.error('[LogWatcher] Error getting file stats:', e);
        return;
    }

    isWatching = true;
    console.log(`[LogWatcher] Started watching ${LOG_FILE_PATH} from byte ${currentSize}`);

    // Запускаем поллинг
    setInterval(checkLogFile, CHECK_INTERVAL_MS);
}

function checkLogFile() {
    try {
        if (!fs.existsSync(LOG_FILE_PATH)) return;

        const stats = fs.statSync(LOG_FILE_PATH);

        // Если файл стал меньше (ротация логов), сбрасываем позицию
        if (stats.size < currentSize) {
            currentSize = 0;
        }

        if (stats.size > currentSize) {
            const stream = fs.createReadStream(LOG_FILE_PATH, {
                start: currentSize,
                end: stats.size,
                encoding: 'utf8',
            });

            let buffer = '';

            stream.on('data', (chunk) => {
                buffer += chunk;
            });

            stream.on('end', () => {
                currentSize = stats.size;
                processLogData(buffer);
            });

            stream.on('error', (err) => {
                console.error('[LogWatcher] Stream error:', err);
            });
        }
    } catch (error) {
        console.error('[LogWatcher] Error processing log file:', error);
    }
}

/**
 * Парсит новые строки лога и ищет запросы к подписке.
 * Стандартный формат combined:
 * IP - - [Date] "METHOD URL PROTOCOL" STATUS BYTES "REFERER" "USER_AGENT"
 */
function processLogData(data: string) {
    const lines = data.split('\n');

    for (const line of lines) {
        if (!line.trim()) continue;

        // Ищем только успешные запросы к /sub/
        if (!line.includes('GET /sub/')) continue;

        try {
            // Очень простой парсинг, чтобы не тянуть тяжелые либы
            // Пример: 72.56.93.135 - - [19/Feb/2026:02:45:12 +0000] "GET /sub/TOKEN... HTTP/1.1" 200 15460 "-" "v2raytun/ios"

            // 1. Извлекаем IP (первое слово)
            const ipMatch = line.match(/^(\S+)/);
            const ipAddress = ipMatch ? ipMatch[1] : 'unknown';

            // 2. Извлекаем URL (между "GET " и " HTTP")
            const urlMatch = line.match(/"GET\s+(\/sub\/[^\s"]+)/);
            const url = urlMatch ? urlMatch[1] : null;

            // 3. Извлекаем User-Agent (последняя часть в кавычках)
            // Находим последнюю кавычку и предыдущую перед ней
            const uaMatch = line.match(/"([^"]+)"$/);
            const userAgent = uaMatch ? uaMatch[1] : 'unknown';

            if (url && userAgent && userAgent !== '-') {
                // Парсим токен из URL: /sub/TOKEN или /sub/TOKEN/info
                const parts = url.split('/');
                const token = parts[2]; // parts[0]='', parts[1]='sub', parts[2]='TOKEN'

                if (token) {
                    const userRef = extractUserRefFromToken(token);
                    if (userRef) {
                        // Асинхронно пишем в БД (можно без await)
                        // setImmediate не нужен, так как это цикл событий
                        try {
                            trackDevice({
                                userRef,
                                userAgent,
                                ipAddress
                            });
                        } catch (e) {
                            // ignore db errors
                        }
                    }
                }
            }
        } catch (err) {
            // Игнорируем ошибки парсинга одной строки
        }
    }
}

function extractUserRefFromToken(token: string): string | null {
    if (!token) return null;
    try {
        // Убираем query params и слеши если есть
        const cleanToken = token.split('?')[0];

        // В Marzban токен начинается с base64-строки
        const chunk = cleanToken.substring(0, 60).replace(/-/g, '+').replace(/_/g, '/');
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
