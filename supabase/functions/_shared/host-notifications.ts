// The database commits these messages with the application/review. A failed
// delivery stays in the outbox, and retries use the same provider idempotency key.
export async function deliverHostNotifications({ db, application, eventType, from, apiKey, send = fetch }: any) {
  const version = eventType === 'submitted' ? application.submitted_at : application.reviewed_at;
  const { data: messages, error } = await db.from('rental_notification_outbox').select('*')
    .eq('application_id', application.id).eq('event_type', eventType).eq('event_version', version);
  if (error) throw error;
  const results = [];
  const escape = (value: unknown) => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  for (const message of messages || []) {
    if (message.sent_at) { results.push({ delivered: true }); continue; }
    try {
      if (!apiKey || !from || from.endsWith('@example.com')) throw new Error('Host email delivery is not configured.');
      const { data, error: userError } = await db.auth.admin.getUserById(message.recipient_user_id);
      if (userError || !data?.user?.email_confirmed_at || !data.user.email) throw new Error('Recipient needs a verified account email.');
      const admin = message.recipient_role === 'admin';
      const notes = String(application.review_notes || '').trim();
      const subject = admin ? 'New short-term host application to review' : {
        submitted: 'Host application received', approved: 'Host application approved',
        rejected: 'Host application update', needs_more_info: 'More information needed for your host application',
      }[eventType as string];
      const text = admin
        ? `${application.legal_name} submitted a host application for ${application.listing_city}, ${application.country}. Log in to 6ixo and open Admin → Host applications to view their private proof and approve, decline, or request more information.`
        : eventType === 'submitted'
          ? 'Your host application is in the admin review inbox. Check your application status in your 6ixo profile.'
          : eventType === 'approved'
            ? 'Your host application is approved. Open your 6ixo profile, complete Stripe payout setup, then post your stay with photos, a nightly price, a cleaning fee, and availability.'
            : `Your host application ${eventType === 'rejected' ? 'was declined' : 'needs more information'}. ${notes ? `Review notes: ${notes}. ` : ''}Update your application in your 6ixo profile and resubmit.`;
      const response = await send('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `host-notification-${message.id}` },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ from, to: [data.user.email], subject, text, html: `<p>${escape(text)}</p><p><a href="https://6ixo.com/">Open 6ixo</a></p>` }),
      });
      if (!response.ok) throw new Error(`Email provider returned ${response.status}.`);
      const { error: saveError } = await db.from('rental_notification_outbox').update({ sent_at: new Date().toISOString(), last_error: null, attempts: (message.attempts || 0) + 1, last_attempt_at: new Date().toISOString() }).eq('id', message.id);
      if (saveError) throw saveError;
      results.push({ delivered: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Email delivery failed.';
      await db.from('rental_notification_outbox').update({ last_error: reason, attempts: (message.attempts || 0) + 1, last_attempt_at: new Date().toISOString(), next_attempt_at: new Date(Date.now() + Math.min(3600, 60 * 2 ** Math.min(message.attempts || 0, 6)) * 1000).toISOString() }).eq('id', message.id);
      results.push({ delivered: false, reason });
    }
  }
  return { delivered: results.length > 0 && results.every(result => result.delivered), pending: results.filter(result => !result.delivered).length, results };
}
