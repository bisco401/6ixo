import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, html, css, migration, integrationTest] = await Promise.all([
    readFile(new URL('../app.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260828120000_add_private_realtime_unread_messaging.sql', import.meta.url), 'utf8'),
    readFile(new URL('./marketplace-messaging.integration.mjs', import.meta.url), 'utf8')
]);

const requiredAppContracts = [
    'subscribeMarketplaceUserRealtime',
    'subscribeMarketplaceConversationRealtime',
    'channel(topic, { config: { private: true } })',
    "rpc('mark_marketplace_conversation_read'",
    'unreadCount',
    'openServerBackedListingConversation'
];
requiredAppContracts.forEach((contract) => {
    assert.ok(app.includes(contract), `Missing client messaging contract: ${contract}`);
});
assert.ok(app.includes('marketplace-conversation:'), 'Production JavaScript is missing private messaging.');
assert.ok(app.includes('mark_marketplace_conversation_read'), 'Production JavaScript is missing read acknowledgements.');
assert.ok(css.includes('has-unread'), 'Production CSS is missing unread conversation styling.');

assert.ok(html.includes('id="profile-message-count"'), 'Profile navigation unread badge is missing.');
assert.ok(html.includes('id="profile-messages-unread"'), 'Messages heading unread badge is missing.');

const requiredSqlContracts = [
    'guest_last_read_at',
    'host_last_read_at',
    'unread_count bigint',
    'mark_marketplace_conversation_read',
    'realtime.broadcast_changes',
    "'marketplace-conversation:'",
    "'marketplace-user:'",
    'on realtime.messages',
    "realtime.messages.extension = 'broadcast'",
    '(select realtime.topic())'
];
requiredSqlContracts.forEach((contract) => {
    assert.ok(migration.includes(contract), `Missing database messaging contract: ${contract}`);
});

assert.ok(integrationTest.includes('Realtime Seller'), 'Two-account test seller setup is missing.');
assert.ok(integrationTest.includes('Realtime Buyer'), 'Two-account test buyer setup is missing.');
assert.ok(integrationTest.includes('unread_count'), 'Two-account test does not verify unread counts.');
assert.ok(integrationTest.includes('config: { private: true }'), 'Two-account test does not use private channels.');

console.log('Messaging contract test passed: private Broadcast, unread state, badges, and two-account coverage are wired.');
