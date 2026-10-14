import { ESCROW_POLICY, EscrowError, assertListing, currencyCode, moneyCents, serviceFeeCents, providerUrls,
  checkoutUrl, transactionPayload, transactionStatus, validateTransaction, publicOrder } from './escrow.ts';

export function escrowBackend(admin: any, env: any, http: typeof fetch = fetch) {
  const urls = providerUrls(env.base || 'https://api.escrow-sandbox.com/2017-09-01');
  let payoutExpires = 0, payoutReady = false;
  async function provider(path: string, body?: any, pay = false) {
    if (!env.email || !env.key) throw new EscrowError(503, 'Escrow payments are not configured yet.');
    const response = await http(pay ? urls.pay : `${urls.api}${path}`, {
      method: body ? 'POST' : 'GET', headers:{Authorization:`Basic ${btoa(`${env.email}:${env.key}`)}`, 'Content-Type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(7000),
    });
    const data = await response.json().catch(()=>({}));
    if (!response.ok) throw new EscrowError(response.status >= 500 ? 503 : response.status, 'Escrow.com could not process this request. Check your account verification and agreed transaction terms.');
    return data;
  }
  async function updateOrder(id: string, values: any) {
    const {data,error} = await admin.from('escrow_transactions').update(values).eq('id',id).select().single();
    if (error || !data) throw new EscrowError(503, 'The escrow record could not be saved. Check My escrow deals before trying again.');
    return data;
  }
  async function assertPayoutReady() {
    if (Date.now() > payoutExpires) {
      const customer = await provider('/customer/me');
      payoutReady = Array.isArray(customer.disbursement_methods) && customer.disbursement_methods.length > 0;
      payoutExpires = Date.now() + 60000;
    }
    if (!payoutReady) throw new EscrowError(503,'Escrow payments are finishing setup. Checkout will be available after 6ixo completes its payout setup.');
  }
  async function refresh(order: any) {
    const verifiedAt = new Date().toISOString();
    const path = order.escrow_transaction_id ? `/transaction/${encodeURIComponent(order.escrow_transaction_id)}` : `/transaction/reference/${encodeURIComponent(order.reference)}`;
    let transaction;
    try { transaction = await provider(path); } catch (error) {
      if (error instanceof EscrowError && error.status === 404 && !order.escrow_transaction_id) return order;
      throw error;
    }
    const candidate = {...order, escrow_transaction_id:String(transaction.id || '')};
    validateTransaction(transaction,candidate,env.email);
    const status = transactionStatus(transaction);
    const {data,error} = await admin.from('escrow_transactions').update({status,escrow_transaction_id:candidate.escrow_transaction_id,
      response_payload:transaction,provider_verified_at:verifiedAt}).eq('id',order.id)
      .or(`provider_verified_at.is.null,provider_verified_at.lte.${verifiedAt}`).select().maybeSingle();
    if (error) throw new EscrowError(503,'The verified escrow status could not be saved.');
    if (status === 'paid') {
      const {error:listingError} = await admin.from('marketplace_listings').update({status:'sold'}).eq('public_id',order.listing_public_id).eq('status','published');
      if (listingError) throw new EscrowError(503,'Payment is complete; the listing could not be marked sold yet.');
    }
    if (data) return data;
    const latest = await admin.from('escrow_transactions').select().eq('id',order.id).single();
    if (latest.error) throw new EscrowError(503,'Unable to read the escrow record.');
    return latest.data;
  }
  return {urls,provider,refresh,updateOrder,assertPayoutReady};
}

export function createEscrowHandler(admin: any, env: any, http: typeof fetch = fetch) {
  const backend = escrowBackend(admin,env,http);
  const allowed = new Set(['https://6ixo.com','https://www.6ixo.com','http://localhost:8000','http://127.0.0.1:8000']);
  return async (req: Request) => {
    const origin = req.headers.get('origin');
    const headers = {'Content-Type':'application/json','Access-Control-Allow-Origin':origin && allowed.has(origin) ? origin : 'https://6ixo.com',
      'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Vary':'Origin'};
    const respond = (data: any, status = 200) => new Response(JSON.stringify(data),{status,headers});
    if (req.method === 'OPTIONS') return new Response('ok',{headers});
    if (req.method !== 'POST') return respond({error:'Method not allowed.'},405);
    if (origin && !allowed.has(origin)) return respond({error:'This origin is not allowed.'},403);
    try {
      const token = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
      if (!token || !admin) throw new EscrowError(401,'Log in to use escrow payments.');
      const {data:auth,error:authError} = await admin.auth.getUser(token);
      if (authError || !auth?.user?.id || !auth.user.email || !auth.user.email_confirmed_at) throw new EscrowError(401,'Use a verified 6ixo account to start an escrow payment.');
      const user = auth.user;
      const payload = await req.json().catch(()=>{throw new EscrowError(400,'Invalid request.');});
      const action = String(payload.action || 'start');
      if (action === 'list') {
        const {data,error} = await admin.from('escrow_transactions').select().or(`buyer_user_id.eq.${user.id},seller_user_id.eq.${user.id}`).order('created_at',{ascending:false}).limit(50);
        if (error) throw new EscrowError(503,'Escrow history is unavailable. Please try again.');
        return respond({ok:true,orders:(data || []).map((order: any)=>publicOrder(order,user.id,backend.urls.sandbox))});
      }
      if (action === 'refresh') {
        const id = String(payload.orderId || '');
        if (!/^et_[a-z0-9]{16}$/.test(id)) throw new EscrowError(400,'Choose a valid escrow order.');
        const {data,error} = await admin.from('escrow_transactions').select().eq('public_id',id).maybeSingle();
        if (error || !data || ![data.buyer_user_id,data.seller_user_id].includes(user.id)) throw new EscrowError(404,'Escrow order not found.');
        const order = await backend.refresh(data);
        return respond({ok:true,order:publicOrder(order,user.id,backend.urls.sandbox)});
      }
      if (!['quote','start'].includes(action)) throw new EscrowError(400,'Unsupported escrow action.');
      const listingId = String(payload.listingId || '').trim();
      if (!listingId || listingId.length > 120) throw new EscrowError(400,'Choose a saved 6ixo listing.');
      const {data:listing,error:listingError} = await admin.from('marketplace_listings').select('public_id,user_id,title,description,price,currency,category,subcategory,status,listing_payload').eq('public_id',listingId).maybeSingle();
      if (listingError) throw new EscrowError(503,'The saved listing could not be loaded.');
      assertListing(listing,user.id);
      const sellerResult = await admin.auth.admin.getUserById(listing.user_id);
      const seller = sellerResult.data?.user;
      if (sellerResult.error || !seller?.email || !seller.email_confirmed_at) throw new EscrowError(409,'The seller must verify their 6ixo email before accepting escrow payments.');
      const buyerEmail = user.email.trim().toLowerCase(), sellerEmail = seller.email.trim().toLowerCase();
      if ([buyerEmail,sellerEmail].includes(String(env.email || '').toLowerCase())) throw new EscrowError(400,'The marketplace escrow account cannot also act as buyer or seller.');
      const amount = moneyCents(listing.price)/100, serviceFee = serviceFeeCents(moneyCents(listing.price))/100;
      const fingerprint = JSON.stringify({listing,serviceFee,policy:ESCROW_POLICY.version});
      const quoteToken = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fingerprint)))).map(b=>b.toString(16).padStart(2,'0')).join('');
      if (action === 'quote') {
        await backend.assertPayoutReady();
        const body = transactionPayload(listing,buyerEmail,sellerEmail,'6ixo-fee-preview');
        const summary = await backend.provider('/transaction/fees-summary',{currency:body.currency,items:body.items,parties:body.parties});
        const total = Number(summary.buyer_price);
        if (!Number.isFinite(total) || total < amount+serviceFee || (summary.broker_proceeds !== undefined && Math.abs(Number(summary.broker_proceeds)-serviceFee)>0.01)) {
          throw new EscrowError(502,'The provider fee quote could not be verified. Checkout is unavailable.');
        }
        return respond({ok:true,quote:{listingId,title:listing.title,amount,serviceFee,currency:listing.currency.toUpperCase(),
          providerFee:Number((total-amount-serviceFee).toFixed(2)),estimatedTotal:total,quoteToken,policy:ESCROW_POLICY,
          environment:backend.urls.sandbox ? 'sandbox' : 'live'}});
      }
      if (payload.agreed !== true) throw new EscrowError(400,'Review and accept the escrow terms before continuing.');
      if (payload.quoteToken !== quoteToken) throw new EscrowError(409,'The listing or fee changed. Review a new quote before continuing.');
      await backend.assertPayoutReady();
      const requestId = String(payload.requestId || '');
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) throw new EscrowError(400,'A checkout request ID is required.');
      const reference = `6ixo-${requestId}`;
      const requestPayload = {...transactionPayload(listing,buyerEmail,sellerEmail,reference),
        return_url:`https://6ixo.com/?escrow_return=${encodeURIComponent(requestId)}`,redirect_type:'manual'};
      const {data:reservation,error:reserveError} = await admin.rpc('reserve_escrow_checkout',{p_order:{
        buyer_user_id:user.id,seller_user_id:listing.user_id,listing_public_id:listingId,buyer_email:buyerEmail,seller_email:sellerEmail,
        amount,currency:currencyCode(listing.currency),listing_currency:listing.currency,service_fee:serviceFee,
        request_id:requestId,reference,fee_policy_version:ESCROW_POLICY.version,listing_snapshot:listing,request_payload:requestPayload,
      }});
      if (reserveError || !reservation?.order) throw new EscrowError(409,'This item may already have an escrow order or its details changed. Check My escrow deals, then review a new quote.');
      let order = reservation.order;
      if (!reservation.isNew) {
        if (!order.checkout_url && order.reference) order = await backend.refresh(order);
        if (!order.checkout_url) throw new EscrowError(409,'Your checkout is being reconciled. Check My escrow deals and manage the transaction on Escrow.com. No new transaction was created.');
        return respond({ok:true,order:publicOrder(order,user.id,backend.urls.sandbox)});
      }
      let providerResponded = false;
      try {
        const result = await backend.provider('',requestPayload,true);
        providerResponded = true;
        const id = String(result.transaction_id || '');
        if (!/^\d+$/.test(id)) throw new EscrowError(502,'Escrow.com did not return a transaction ID.');
        const url = checkoutUrl(result.landing_page,backend.urls.sandbox);
        order = await backend.updateOrder(order.id,{escrow_transaction_id:id,checkout_url:url,status:'awaiting_agreement',response_payload:result});
        return respond({ok:true,order:publicOrder(order,user.id,backend.urls.sandbox)});
      } catch (error) {
        // A timeout/5xx or a failed local save may already have created a provider transaction. Never blindly recreate it.
        const knownRejection = !providerResponded && error instanceof EscrowError && [400,401,403,404,409,422].includes(error.status);
        await backend.updateOrder(order.id,{status:knownRejection ? 'failed' : 'pending_review'}).catch(()=>{});
        throw new EscrowError(503,knownRejection ? 'Escrow.com could not start checkout. Please check account verification before retrying.' : 'Checkout confirmation is pending. Check My escrow deals before retrying so a duplicate payment is not created.');
      }
    } catch (error) {
      return respond({error:error instanceof EscrowError ? error.message : 'Escrow is temporarily unavailable. Check My escrow deals before retrying.'},error instanceof EscrowError ? error.status : 503);
    }
  };
}
