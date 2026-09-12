// Destination charges require the transfers capability, not just a bank account.
export function isRentalPayoutReady(account: {
  deleted?: boolean;
  details_submitted?: boolean;
  payouts_enabled?: boolean;
  capabilities?: { transfers?: string } | null;
}) {
  return !account.deleted && Boolean(account.details_submitted && account.payouts_enabled)
    && account.capabilities?.transfers === 'active';
}
