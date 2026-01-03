// Конфигурация планов и их цен (синхронизировано с vpn_bot)
export const PLAN_PRICES: Record<string, { value: string; currency: string }> = {
  'plan_7': {
    value: '10.00',
    currency: 'RUB',
  },
  'plan_30': {
    value: '99.00',
    currency: 'RUB',
  },
  'plan_90': {
    value: '260.00',
    currency: 'RUB',
  },
  'plan_180': {
    value: '499.00',
    currency: 'RUB',
  },
  'plan_365': {
    value: '899.00',
    currency: 'RUB',
  },
};

// Дефолтная цена (на случай ошибки)
export const DEFAULT_PLAN_PRICE = {
  value: '99.00',
  currency: 'RUB',
};

export function getPlanPrice(planId: string): { value: string; currency: string } {
  return PLAN_PRICES[planId] || DEFAULT_PLAN_PRICE;
}
