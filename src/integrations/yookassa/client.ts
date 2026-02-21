import { v4 as uuidv4 } from 'uuid';

export interface YooKassaReceiptItem {
  description: string;
  quantity: string;
  amount: {
    value: string;
    currency: string;
  };
  vat_code: number;
  payment_subject?: string; // 'commodity' | 'service' | 'payment' | 'agent_commission' | 'gambling_bet' | 'gambling_prize' | 'lottery' | 'lottery_prize' | 'intellectual_activity' | 'payment' | 'agent_commission' | 'composite' | 'another'
  payment_mode?: string; // 'full_prepayment' | 'partial_prepayment' | 'advance' | 'full_payment' | 'partial_payment' | 'credit' | 'credit_payment'
}

export interface YooKassaReceipt {
  customer: {
    email?: string;
    phone?: string;
  };
  items: YooKassaReceiptItem[];
}

export interface YooKassaPaymentParams {
  amount: {
    value: string;
    currency: string;
  };
  capture: boolean;
  confirmation?: {
    type: string;
    return_url: string;
  };
  payment_method_id?: string;
  save_payment_method?: boolean;
  description: string;
  metadata: Record<string, string>;
  receipt?: YooKassaReceipt;
}

export interface YooKassaPaymentResponse {
  id: string;
  status: string;
  confirmation?: {
    confirmation_url: string;
  };
  paid: boolean;
  amount: {
    value: string;
    currency: string;
  };
  metadata: Record<string, string>;
  payment_method?: {
    type: string;
    id: string;
    saved: boolean;
    title?: string;
  };
}

export interface YooKassaClientConfig {
  shopId: string;
  secretKey: string;
  baseUrl?: string;
}

export class YooKassaClient {
  private shopId: string;
  private secretKey: string;
  private baseUrl: string;

  constructor(config: YooKassaClientConfig) {
    this.shopId = config.shopId;
    this.secretKey = config.secretKey;
    this.baseUrl = config.baseUrl || 'https://api.yookassa.ru/v3';
  }

  async createPayment(
    params: YooKassaPaymentParams,
    idempotenceKey?: string
  ): Promise<YooKassaPaymentResponse> {
    const key = idempotenceKey || uuidv4();
    const auth = Buffer.from(`${this.shopId}:${this.secretKey}`).toString('base64');

    // Таймаут для запроса к YooKassa (30 секунд)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(`${this.baseUrl}/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`,
          'Idempotence-Key': key,
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        let errorDetails: unknown;
        try {
          errorDetails = JSON.parse(errorText);
        } catch {
          errorDetails = errorText;
        }

        // Специальная обработка ошибки аутентификации
        if (response.status === 401) {
          const errorMsg = typeof errorDetails === 'object' && errorDetails !== null && 'code' in errorDetails
            ? `YooKassa authentication failed: ${JSON.stringify(errorDetails)}. Проверьте YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY в .env`
            : `YooKassa authentication failed. Проверьте YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY в .env`;
          throw new Error(errorMsg);
        }

        throw new Error(
          `YooKassa API error: ${response.status} ${response.statusText}. Details: ${JSON.stringify(errorDetails)}`
        );
      }

      const result = await response.json() as YooKassaPaymentResponse;
      return result;
    } catch (error) {
      clearTimeout(timeoutId);

      // Обработка таймаута
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('YooKassa API timeout: запрос превысил 30 секунд');
      }

      // Пробрасываем другие ошибки
      throw error;
    }
  }

  async getPayment(paymentId: string): Promise<YooKassaPaymentResponse> {
    const auth = Buffer.from(`${this.shopId}:${this.secretKey}`).toString('base64');

    try {
      const response = await fetch(`${this.baseUrl}/payments/${paymentId}`, {
        headers: {
          'Authorization': `Basic ${auth}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`YooKassa API error: ${response.status} ${response.statusText}. Details: ${errorText}`);
      }

      return await response.json() as YooKassaPaymentResponse;
    } catch (error) {
      throw error;
    }
  }
}

