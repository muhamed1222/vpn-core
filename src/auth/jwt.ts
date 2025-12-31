import * as jwt from 'jsonwebtoken';

export interface JWTPayload {
  tgId: number;
  username?: string;
  firstName?: string;
  iat?: number;
  exp?: number;
}

export interface CreateTokenParams {
  tgId: number;
  username?: string;
  firstName?: string;
  secret: string;
  expiresInDays?: number; // По умолчанию 7 дней
}

export interface VerifyTokenParams {
  token: string;
  secret: string;
}

/**
 * Создает JWT токен для пользователя
 */
export function createToken(params: CreateTokenParams): string {
  const { tgId, username, firstName, secret, expiresInDays = 7 } = params;

  const payload: JWTPayload = {
    tgId,
    username,
    firstName,
  };

  return jwt.sign(payload, secret, {
    expiresIn: `${expiresInDays}d`,
  });
}

/**
 * Проверяет и декодирует JWT токен
 */
export function verifyToken(params: VerifyTokenParams): JWTPayload | null {
  const { token, secret } = params;

  try {
    const decoded = jwt.verify(token, secret) as JWTPayload;
    return decoded;
  } catch (error) {
    return null;
  }
}


