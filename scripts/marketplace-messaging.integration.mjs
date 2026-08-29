import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = String(process.env.SUPABASE_TEST_URL || 'http://127.0.0.1:54321').trim();
const anonKey = String(process.env.SUPABASE_TEST_ANON_KEY || '').trim();
const serviceRoleKey = String(process.env.SUPABASE_TEST_SERVICE_ROLE_KEY || '').trim();
const allowRemote = process.env.ALLOW_REMOTE_SUPABASE_TEST === '1';
const testUrl = new URL(supabaseUrl);
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(testUrl.hostname);

if (!isLocal && !allowRemote) {
    throw new Error('Refusing to run destructive messaging setup against a remote Supabase project. Set ALLOW_REMOTE_SUPABASE_TEST=1 only for an isolated test project.');
}
if (!anonKey || !serviceRoleKey) {
    throw new Error('Set SUPABASE_TEST_ANON_KEY and SUPABASE_TEST_SERVICE_ROLE_KEY. Use `supabase status -o env` for a running local stack.');
}

const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const publicIdSuffix = unique.replace(/[^a-z0-9]/gi, '').toLowerCase();
const password = `Messaging-${unique}-Aa1!`;
const buyerEmail = `messaging-buyer-${unique}@example.test`;
const sellerEmail = `messaging-seller-${unique}@example.test`;
const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
});
const buyer = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
});
const seller = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
});

const createdUserIds = [];
let listingId = '';
let conversationId = '';

function unwrapRpcRow(data) {
    return Array.isArray(data) ? (data[0] || null) : (data || null);
}

function eventRecord(event) {
    const envelope = event?.payload && typeof event.payload === 'object' ? event.payload : event;
    return envelope?.record || envelope?.new || event?.record || null;
}

function subscribePrivate(client, topic, label, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const channel = client.channel(topic, { config: { private: true } });
        const events = [];
        const waiters = [];
        channel.on('broadcast', { event: 'INSERT' }, (payload) => {
            const waiter = waiters.shift();
            if (waiter) waiter(payload);
            else events.push(payload);
        });
        const timer = setTimeout(() => reject(new Error(`Timed out subscribing to ${label}.`)), timeoutMs);
        channel.subscribe((status, error) => {
            if (status === 'SUBSCRIBED') {
                clearTimeout(timer);
                resolve({
                    channel,
                    nextBroadcast(waitMs = timeoutMs) {
                        if (events.length) return Promise.resolve(events.shift());
                        return new Promise((resolveEvent, rejectEvent) => {
                            const eventTimer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${label} broadcast.`)), waitMs);
                            waiters.push((payload) => {
                                clearTimeout(eventTimer);
                                resolveEvent(payload);
                            });
                        });
                    }
                });
            } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
                clearTimeout(timer);
                const detail = String(error?.message || error?.error || '').trim();
                reject(new Error(`${label} subscription failed with ${status}${detail ? `: ${detail}` : ''}.`));
            }
        });
    });
}

function expectPrivateSubscriptionDenied(client, topic, label, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const channel = client.channel(topic, { config: { private: true } });
        const finish = async (error = null) => {
            clearTimeout(timer);
            await client.removeChannel(channel).catch(() => {});
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => {
            void finish(new Error(`Timed out checking private access to ${label}.`));
        }, timeoutMs);
        channel.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                void finish(new Error(`Unauthorized account subscribed to ${label}.`));
            } else if (status === 'CHANNEL_ERROR') {
                void finish();
            }
        });
    });
}

async function createConfirmedUser(email, displayName) {
    const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: displayName }
    });
    if (error) throw error;
    assert.ok(data.user?.id, `Expected an id for ${displayName}.`);
    createdUserIds.push(data.user.id);
    return data.user;
}

async function signIn(client, email) {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    assert.ok(data.session?.access_token, `Expected a session for ${email}.`);
    await client.realtime.setAuth(data.session.access_token);
    return data.user;
}

async function cleanup() {
    await Promise.allSettled([
        buyer.removeAllChannels(),
        seller.removeAllChannels(),
        buyer.auth.signOut(),
        seller.auth.signOut()
    ]);
    if (conversationId) {
        await admin.from('marketplace_conversations').delete().eq('public_id', conversationId);
    }
    if (listingId) {
        await admin.from('marketplace_listings').delete().eq('id', listingId);
    }
    for (const userId of createdUserIds.reverse()) {
        await admin.auth.admin.deleteUser(userId);
    }
}

try {
    const sellerUser = await createConfirmedUser(sellerEmail, 'Realtime Seller');
    const buyerUser = await createConfirmedUser(buyerEmail, 'Realtime Buyer');
    await signIn(seller, sellerEmail);
    await signIn(buyer, buyerEmail);

    const { data: sellerProfile, error: sellerProfileError } = await seller
        .from('marketplace_profiles')
        .insert({
            public_id: `mp_test_seller_${publicIdSuffix}`,
            user_id: sellerUser.id,
            display_name: 'Realtime Seller',
            country: 'Canada'
        })
        .select('id')
        .single();
    if (sellerProfileError) throw sellerProfileError;

    const { error: buyerProfileError } = await buyer
        .from('marketplace_profiles')
        .insert({
            public_id: `mp_test_buyer_${publicIdSuffix}`,
            user_id: buyerUser.id,
            display_name: 'Realtime Buyer',
            country: 'Canada'
        });
    if (buyerProfileError) throw buyerProfileError;

    const { data: listing, error: listingError } = await seller
        .from('marketplace_listings')
        .insert({
            public_id: `ml_test_${publicIdSuffix}`,
            user_id: sellerUser.id,
            marketplace_profile_id: sellerProfile.id,
            category: 'electronics',
            title: 'Two-account realtime test listing',
            description: 'Temporary integration-test listing',
            price: 25,
            currency: 'CAD',
            city: 'Toronto',
            country: 'Canada',
            status: 'published',
            listing_payload: { seller: 'Realtime Seller' }
        })
        .select('id, public_id')
        .single();
    if (listingError) throw listingError;
    listingId = listing.id;

    const { data: conversationData, error: conversationError } = await buyer.rpc('get_or_create_listing_conversation', {
        p_listing_public_id: listing.public_id,
        p_listing_source: 'marketplace'
    });
    if (conversationError) throw conversationError;
    const conversation = unwrapRpcRow(conversationData);
    assert.ok(conversation?.conversation_public_id, 'Buyer should be able to open a seller conversation.');
    conversationId = conversation.conversation_public_id;

    const buyerConversationSubscription = await subscribePrivate(
        buyer,
        `marketplace-conversation:${conversationId}`,
        'buyer conversation channel'
    );
    const sellerInboxSubscription = await subscribePrivate(
        seller,
        `marketplace-user:${sellerUser.id}`,
        'seller inbox channel'
    );
    const buyerInboxSubscription = await subscribePrivate(
        buyer,
        `marketplace-user:${buyerUser.id}`,
        'buyer inbox channel'
    );
    await expectPrivateSubscriptionDenied(
        buyer,
        `marketplace-user:${sellerUser.id}`,
        'the seller private inbox'
    );
    const buyerConversationBroadcast = buyerConversationSubscription.nextBroadcast();
    const sellerInboxBroadcast = sellerInboxSubscription.nextBroadcast();

    const buyerMessage = `Hello seller ${unique}`;
    const { data: buyerSendData, error: buyerSendError } = await buyer.rpc('send_marketplace_conversation_message', {
        p_conversation_public_id: conversationId,
        p_body: buyerMessage
    });
    if (buyerSendError) throw buyerSendError;
    const buyerSent = unwrapRpcRow(buyerSendData);
    assert.equal(buyerSent?.body, buyerMessage);

    const [conversationEvent, inboxEvent] = await Promise.all([buyerConversationBroadcast, sellerInboxBroadcast]);
    assert.equal(eventRecord(conversationEvent)?.body, buyerMessage, 'Private conversation broadcast should contain the inserted message.');
    assert.equal(eventRecord(inboxEvent)?.body, buyerMessage, 'Private seller inbox broadcast should contain the inserted message.');

    const { data: sellerInbox, error: sellerInboxError } = await seller.rpc('get_my_marketplace_conversations');
    if (sellerInboxError) throw sellerInboxError;
    const sellerConversation = sellerInbox.find((row) => row.conversation_public_id === conversationId);
    assert.equal(Number(sellerConversation?.unread_count), 1, 'Seller should have one unread buyer message.');

    const { error: markReadError } = await seller.rpc('mark_marketplace_conversation_read', {
        p_conversation_public_id: conversationId
    });
    if (markReadError) throw markReadError;
    const { data: sellerReadInbox, error: sellerReadInboxError } = await seller.rpc('get_my_marketplace_conversations');
    if (sellerReadInboxError) throw sellerReadInboxError;
    assert.equal(
        Number(sellerReadInbox.find((row) => row.conversation_public_id === conversationId)?.unread_count),
        0,
        'Marking the conversation read should clear the seller unread count.'
    );

    const buyerReplyBroadcast = buyerConversationSubscription.nextBroadcast();
    const buyerInboxReplyBroadcast = buyerInboxSubscription.nextBroadcast();
    const sellerReply = `Hello buyer ${unique}`;
    const { error: sellerSendError } = await seller.rpc('send_marketplace_conversation_message', {
        p_conversation_public_id: conversationId,
        p_body: sellerReply
    });
    if (sellerSendError) throw sellerSendError;
    const [buyerConversationReplyEvent, buyerInboxReplyEvent] = await Promise.all([
        buyerReplyBroadcast,
        buyerInboxReplyBroadcast
    ]);
    assert.equal(eventRecord(buyerConversationReplyEvent)?.body, sellerReply, 'Buyer should receive the seller reply in the private conversation.');
    assert.equal(eventRecord(buyerInboxReplyEvent)?.body, sellerReply, 'Buyer should receive the seller reply in the private inbox.');

    const { data: buyerInbox, error: buyerInboxError } = await buyer.rpc('get_my_marketplace_conversations');
    if (buyerInboxError) throw buyerInboxError;
    assert.equal(
        Number(buyerInbox.find((row) => row.conversation_public_id === conversationId)?.unread_count),
        1,
        'Buyer should have one unread seller reply.'
    );

    const { data: messages, error: messagesError } = await buyer.rpc('get_marketplace_conversation_messages', {
        p_conversation_public_id: conversationId
    });
    if (messagesError) throw messagesError;
    assert.deepEqual(messages.map((message) => message.body), [buyerMessage, sellerReply]);

    console.log('Two-account private realtime messaging test passed.');
} finally {
    await cleanup();
}
