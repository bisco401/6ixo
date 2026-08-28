export type SubscriptionPlan = {
  amountCents: number;
  interval: 'month' | 'year';
  label: string;
  productKey: 'dating_premium' | 'seller_pro';
  productName: string;
  productDescription: string;
  subscriptionTable: 'premium_subscriptions' | 'seller_subscriptions';
  checkoutKind: 'premium' | 'seller_pro';
};

export const SUBSCRIPTION_PLANS = {
  premium_monthly: {
    amountCents: 499,
    interval: 'month',
    label: '6ixo Premium Monthly',
    productKey: 'dating_premium',
    productName: '6ixo Premium',
    productDescription: 'Premium visibility, messaging, and travel-discovery features on 6ixo.',
    subscriptionTable: 'premium_subscriptions',
    checkoutKind: 'premium',
  },
  premium_annual: {
    amountCents: 3499,
    interval: 'year',
    label: '6ixo Premium Annual',
    productKey: 'dating_premium',
    productName: '6ixo Premium',
    productDescription: 'Premium visibility, messaging, and travel-discovery features on 6ixo.',
    subscriptionTable: 'premium_subscriptions',
    checkoutKind: 'premium',
  },
  seller_pro_monthly: {
    amountCents: 1999,
    interval: 'month',
    label: '6ixo Seller Pro Monthly',
    productKey: 'seller_pro',
    productName: '6ixo Seller Pro',
    productDescription: 'Seller analytics, campaign reporting, listing insights, and priority support on 6ixo.',
    subscriptionTable: 'seller_subscriptions',
    checkoutKind: 'seller_pro',
  },
  seller_pro_annual: {
    amountCents: 19900,
    interval: 'year',
    label: '6ixo Seller Pro Annual',
    productKey: 'seller_pro',
    productName: '6ixo Seller Pro',
    productDescription: 'Seller analytics, campaign reporting, listing insights, and priority support on 6ixo.',
    subscriptionTable: 'seller_subscriptions',
    checkoutKind: 'seller_pro',
  },
} as const satisfies Record<string, SubscriptionPlan>;

export type SubscriptionPlanKey = keyof typeof SUBSCRIPTION_PLANS;

export const PROMOTION_PRICING_USD: Record<string, number> = Object.freeze({
  home: 15,
  nearby: 15,
  dating: 15,
  companionship: 15,
  all: 39,
  arrive_plus: 5.99,
  premium: 1.99,
  dating_featured: 1.99,
  companionship_feed_boost_pass: 4.99,
  companionship_featured: 9.99,
  today_deals_featured: 9.99,
  home_featured: 9.99,
  marketplace_featured: 9.99,
  community_featured: 9.99,
  jobs_featured: 9.99,
  services_featured: 9.99,
  vehicles_featured: 9.99,
  realestate_featured: 9.99,
  electronics_featured: 9.99,
});

export const PROMOTION_DURATION_HOURS: Record<string, number> = Object.freeze({
  premium: 48,
  dating_featured: 48,
  companionship_feed_boost_pass: 24,
  companionship_featured: 168,
  today_deals_featured: 168,
  home_featured: 168,
  marketplace_featured: 168,
  community_featured: 168,
  jobs_featured: 168,
  services_featured: 168,
  vehicles_featured: 168,
  realestate_featured: 168,
  electronics_featured: 168,
  home: 168,
  nearby: 168,
  dating: 168,
  companionship: 168,
  all: 168,
});

export function isSubscriptionPlanKey(value: string): value is SubscriptionPlanKey {
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTION_PLANS, value);
}
