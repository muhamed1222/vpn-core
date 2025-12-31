// Конфигурация планов и их цен
export const PLAN_PRICES: Record<string, { value: string; currency: string }> = {
  'month': {
    value: '299.00',
    currency: 'RUB',
  },
  'plan-basic': {
    value: '299.00',
    currency: 'RUB',
  },
  'plan-standard': {
    value: '599.00',
    currency: 'RUB',
  },
  'plan-premium': {
    value: '999.00',
    currency: 'RUB',
  },
};

// Дефолтная цена, если план не найден
export const DEFAULT_PLAN_PRICE = {
  value: '299.00',
  currency: 'RUB',
};

export function getPlanPrice(planId: string): { value: string; currency: string } {
  return PLAN_PRICES[planId] || DEFAULT_PLAN_PRICE;
}

