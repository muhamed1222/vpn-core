import { getDatabase } from './db.js';

export interface OrderRow {
  order_id: string;
  user_ref: string | null;
  plan_id: string;
  status: 'pending' | 'paid' | 'completed' | 'canceled';
  yookassa_payment_id: string | null;
  amount_value: string | null;
  amount_currency: string | null;
  bonus_days: number;
  key: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentEventRow {
  id: number;
  yookassa_event_id: string | null;
  yookassa_payment_id: string;
  event: string;
  created_at: string;
}

export function createOrder(params: {
  orderId: string;
  planId: string;
  userRef?: string;
  bonusDays?: number;
}): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO orders (
      order_id, user_ref, plan_id, status,
      yookassa_payment_id, amount_value, amount_currency, bonus_days, key,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL, ?, ?)
  `).run(
    params.orderId,
    params.userRef || '',
    params.planId,
    params.bonusDays || 0,
    now,
    now
  );
}

export function getOrder(orderId: string): OrderRow | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as OrderRow | undefined;
  return row || null;
}

export function getOrderByPaymentId(yookassaPaymentId: string): OrderRow | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM orders WHERE yookassa_payment_id = ?').get(yookassaPaymentId) as OrderRow | undefined;
  return row || null;
}

export function setPaymentId(params: {
  orderId: string;
  yookassaPaymentId: string;
  amountValue?: string;
  amountCurrency?: string;
}): boolean {
  const db = getDatabase();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE orders
    SET yookassa_payment_id = ?,
        amount_value = ?,
        amount_currency = ?,
        updated_at = ?
    WHERE order_id = ?
  `).run(
    params.yookassaPaymentId,
    params.amountValue || null,
    params.amountCurrency || null,
    now,
    params.orderId
  );

  return result.changes > 0;
}

export function markPaidWithKey(params: {
  orderId: string;
  key: string;
}): boolean {
  const db = getDatabase();
  const now = new Date().toISOString();

  if (!params.key || params.key.trim() === '') {
    console.error(`[ordersRepo] markPaidWithKey: empty key for order ${params.orderId}`);
    return false;
  }

  // Идемпотентная операция: если уже paid и ТАКОЙ ЖЕ key есть, ничего не делаем
  const order = getOrder(params.orderId);
  if (order && order.status === 'paid' && order.key === params.key) {
    console.log(`[ordersRepo] markPaidWithKey: order ${params.orderId} already has this key`);
    return true; // Уже обработано
  }

  console.log(`[ordersRepo] markPaidWithKey: saving key for order ${params.orderId}, key length: ${params.key.length}`);

  const result = db.prepare(`
    UPDATE orders
    SET status = 'paid',
        key = ?,
        updated_at = ?
    WHERE order_id = ?
  `).run(
    params.key,
    now,
    params.orderId
  );

  console.log(`[ordersRepo] markPaidWithKey: updated ${result.changes} rows for order ${params.orderId}`);

  return result.changes > 0;
}

export function markCanceled(orderId: string): boolean {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Идемпотентная операция: если уже canceled, ничего не делаем
  const order = getOrder(orderId);
  if (order && order.status === 'canceled') {
    return true; // Уже обработано
  }

  const result = db.prepare(`
    UPDATE orders
    SET status = 'canceled',
        updated_at = ?
    WHERE order_id = ?
  `).run(
    now,
    orderId
  );

  return result.changes > 0;
}

export function hasKey(orderId: string): boolean {
  const order = getOrder(orderId);
  return order !== null && order.key !== null && order.key !== '';
}

export function recordPaymentEvent(params: {
  yookassaEventId?: string;
  yookassaPaymentId: string;
  event: string;
}): boolean {
  const db = getDatabase();
  const now = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO payment_events (
        yookassa_event_id, yookassa_payment_id, event, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      params.yookassaEventId || null,
      params.yookassaPaymentId,
      params.event,
      now
    );
    return true;
  } catch (error: unknown) {
    // Если yookassa_event_id уже существует (UNIQUE constraint), игнорируем
    if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
      return false; // Уже обработано
    }
    throw error;
  }
}

export function hasPaymentEvent(params: {
  yookassaEventId?: string;
  yookassaPaymentId: string;
  event: string;
}): boolean {
  const db = getDatabase();

  if (params.yookassaEventId) {
    const row = db.prepare(`
      SELECT 1 FROM payment_events
      WHERE yookassa_event_id = ?
    `).get(params.yookassaEventId);
    return row !== undefined;
  }

  // Если нет event_id, проверяем по payment_id и event
  const row = db.prepare(`
    SELECT 1 FROM payment_events
    WHERE yookassa_payment_id = ? AND event = ?
  `).get(params.yookassaPaymentId, params.event);
  return row !== undefined;
}

export function getOrdersByUser(userRef: string): OrderRow[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM orders 
    WHERE user_ref = ? 
    ORDER BY created_at DESC 
    LIMIT 50
  `).all(userRef) as OrderRow[];
}

export function getLastKeyForUser(userRef: string): string | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT key FROM orders 
    WHERE user_ref = ? AND status = 'paid' AND key IS NOT NULL AND key != ''
    ORDER BY updated_at DESC 
    LIMIT 1
  `).get(userRef) as { key: string } | undefined;
  return row ? row.key : null;
}

