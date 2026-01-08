export interface Order {
  orderId: string;
  planId: string;
  userRef?: string;
  status: 'pending' | 'paid';
  key?: string;
  createdAt: Date;
}

export interface CreateOrderRequest {
  planId: string;
  tgId?: number; // Для создания заказа от имени админа (бота)
  // userRef больше не принимается из body, берется из авторизованного пользователя
}

export interface CreateOrderResponse {
  orderId: string;
  status: 'pending';
  paymentUrl: string;
}

export interface GetOrderResponse {
  orderId: string;
  status: 'pending' | 'paid';
  key?: string;
}

export interface WebhookEvent {
  event: string;
  orderId?: string;
  [key: string]: unknown;
}

