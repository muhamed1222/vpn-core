import * as crypto from 'crypto';

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string; // URL фотографии профиля (если доступна)
}

export interface VerifyTelegramInitDataParams {
  initData: string;
  botToken: string;
  maxAgeSeconds?: number; // По умолчанию 86400 (24 часа)
}

export interface VerifyTelegramInitDataResult {
  valid: boolean;
  user?: TelegramUser;
  error?: string;
}

/**
 * Проверяет initData от Telegram WebApp
 * 
 * Алгоритм:
 * 1. Парсит initData как querystring
 * 2. Извлекает hash
 * 3. Формирует data_check_string (все пары кроме hash, отсортированные по key, склеенные через \n)
 * 4. Вычисляет secret_key = HMAC_SHA256("WebAppData", botToken)
 * 5. Вычисляет check_hash = HMAC_SHA256(secret_key, data_check_string) -> hex lowercase
 * 6. Сравнивает с hash
 * 7. Проверяет auth_date (не старше maxAgeSeconds)
 * 8. Извлекает user из параметра user (JSON строка)
 */
export function verifyTelegramInitData(
  params: VerifyTelegramInitDataParams
): VerifyTelegramInitDataResult {
  const { initData, botToken, maxAgeSeconds = 86400 } = params;

  // РАЗРЕШАЕМ ЛОКАЛЬНУЮ РАЗРАБОТКУ
  if (initData.includes('query_id=STUB') && process.env.NODE_ENV === 'development') {
    return {
      valid: true,
      user: {
        id: 12345678,
        first_name: 'Developer',
        username: 'dev'
      }
    };
  }

  try {
    // Парсим initData как querystring
    // Сохраняем оригинальные значения для data_check_string
    const originalParamsMap = new Map<string, string>();
    const decodedParamsMap = new Map<string, string>();
    const pairs = initData.split('&');
    
    let hash: string | null = null;
    
    for (const pair of pairs) {
      const [key, rawValue = ''] = pair.split('=');
      const decodedValue = decodeURIComponent(rawValue);
      
      if (key === 'hash') {
        hash = decodedValue;
      } else {
        // ВАЖНО: Используем ДЕКОДИРОВАННЫЕ значения для data_check_string
        originalParamsMap.set(key, decodedValue); 
        decodedParamsMap.set(key, decodedValue); 
      }
    }

    if (!hash) {
      return { valid: false, error: 'Hash not found in initData' };
    }

    // Формируем data_check_string: все пары кроме hash, отсортированные по key, склеенные через \n
    // ВАЖНО: Используем оригинальные (URL-encoded) значения из строки initData
    const sortedKeys = Array.from(originalParamsMap.keys()).sort();
    const dataCheckString = sortedKeys
      .map(key => `${key}=${originalParamsMap.get(key)}`)
      .join('\n');

    // Логируем для отладки (только на этапе разработки/отладки)
    // console.log('Data Check String:', dataCheckString);
    // console.log('Hash from Telegram:', hash);

    // Вычисляем secret_key = HMAC_SHA256("WebAppData", botToken) (raw bytes)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // Вычисляем check_hash = HMAC_SHA256(secret_key, data_check_string) -> hex lowercase
    const checkHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex')
      .toLowerCase();

    // Сравниваем hash
    if (hash.toLowerCase() !== checkHash) {
      return { valid: false, error: 'Hash verification failed' };
    }

    // Проверяем auth_date (используем декодированное значение)
    const authDateStr = decodedParamsMap.get('auth_date');
    if (!authDateStr) {
      return { valid: false, error: 'auth_date not found' };
    }

    const authDate = parseInt(authDateStr, 10);
    if (isNaN(authDate)) {
      return { valid: false, error: 'Invalid auth_date format' };
    }

    const now = Math.floor(Date.now() / 1000);
    const age = now - authDate;
    
    if (age > maxAgeSeconds) {
      return { valid: false, error: `auth_date too old: ${age} seconds (max: ${maxAgeSeconds})` };
    }

    // Извлекаем user из параметра user (JSON строка) - используем декодированное значение
    const userStr = decodedParamsMap.get('user');
    if (!userStr) {
      return { valid: false, error: 'user not found in initData' };
    }

    let user: TelegramUser;
    try {
      user = JSON.parse(userStr);
    } catch (e) {
      return { valid: false, error: 'Invalid user JSON format' };
    }

    if (!user.id || typeof user.id !== 'number') {
      return { valid: false, error: 'Invalid user.id' };
    }

    return { valid: true, user };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


