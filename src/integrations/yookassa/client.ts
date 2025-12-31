import { v4 as uuidv4 } from 'uuid';

export interface YooKassaReceiptItem {
  description: string;
  quantity: string;
  amount: {
    value: string;
    currency: string;
  };
  vat_code: number;
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
  confirmation: {
    type: string;
    return_url: string;
  };
  description: string;
  metadata: Record<string, string>;
  receipt?: YooKassaReceipt;
}

export interface YooKassaPaymentResponse {
  id: string;
  status: string;
  confirmation: {
    confirmation_url: string;
  };
  paid: boolean;
  amount: {
    value: string;
    currency: string;
  };
  metadata: Record<string, string>;
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

    const response = await fetch(`${this.baseUrl}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'Idempotence-Key': key,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorDetails: unknown;
      try {
        errorDetails = JSON.parse(errorText);
      } catch {
        errorDetails = errorText;
      }

      throw new Error(
        `YooKassa API error: ${response.status} ${response.statusText}. Details: ${JSON.stringify(errorDetails)}`
      );
    }

    const result = await response.json() as YooKassaPaymentResponse;
    return result;
  }
}

