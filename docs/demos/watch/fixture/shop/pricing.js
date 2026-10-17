export const COUPONS = {
  WELCOME10: { pct: 10 },
  AUTUMN25: { pct: 25 },
};

/** The order total in cents, after the cart's coupon. */
export function total(cart) {
  const sum = cart.items.reduce((s, i) => s + i.cents * i.qty, 0);
  if (!cart.coupon) return sum;
  const off = COUPONS[cart.coupon].pct;
  return Math.round(sum * (1 - off / 100));
}
