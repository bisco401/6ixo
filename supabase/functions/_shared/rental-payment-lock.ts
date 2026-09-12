export async function acquireRentalPaymentLock(db: any, publicId: string, userId: string) {
  const { data, error } = await db.rpc('claim_short_term_payment_action', { p_booking_public_id: publicId, p_actor_id: userId });
  if (error) throw Object.assign(new Error(error.message || 'Another payment action is in progress. Please refresh and retry.'), { status: 409 });
  return data;
}

export async function releaseRentalPaymentLock(db: any, token: string | null) {
  if (!token) return;
  const { error } = await db.rpc('release_short_term_payment_action', { p_token: token });
  if (error) console.warn('Payment action lock will expire automatically.');
}
