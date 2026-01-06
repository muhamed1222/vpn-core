// Конфигурация планов и их цен (синхронизировано с vpn_bot)
export const PLAN_PRICES: Record<string, { value: string; stars: number; currency: string }> = {
  'plan_7': {
    value: '10.00',
    stars: 2,
    currency: 'RUB',
  },
  'plan_30': {
    value: '99.00',
    stars: 75,
    currency: 'RUB',
  },
  'plan_90': {
    value: '260.00',
    stars: 190,
    currency: 'RUB',
  },
  'plan_180': {
    value: '499.00',
    stars: 370,
    currency: 'RUB',
  },
  'plan_365': {
    value: '899.00',
    stars: 650,
    currency: 'RUB',
  },
};

// Дефолтная цена (на случай ошибки)
export const DEFAULT_PLAN_PRICE = {
  value: '99.00',
  stars: 75,
  currency: 'RUB',
};

export function getPlanPrice(planId: string): { value: string; stars: number; currency: string } {
  return PLAN_PRICES[planId] || DEFAULT_PLAN_PRICE;
}
