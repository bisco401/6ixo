import { ESCROW_POLICY, providerUrls, transactionPayload } from '../_shared/escrow.ts';
const email = Deno.env.get('ESCROW_API_EMAIL') || '';
const key = Deno.env.get('ESCROW_API_KEY') || '';
const base = Deno.env.get('ESCROW_API_BASE_URL') || 'https://api.escrow-sandbox.com/2017-09-01';
let cached: any = null;
let expires = 0;
let feeExample: any = null;
Deno.serve(async (req) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('ok', {headers});
  if (!['GET','POST'].includes(req.method)) return new Response('{}',{status:405,headers});
  if (!cached || Date.now() > expires) {
    let connected = false, sandbox = true, payoutReady = false;
    try {
      const urls = providerUrls(base); sandbox = urls.sandbox;
      if (email && key) {
        const response = await fetch(`${urls.api}/customer/me`, {headers:{Authorization:`Basic ${btoa(`${email}:${key}`)}`}, signal:AbortSignal.timeout(6000)});
        connected = response.ok;
        const customer = await response.json().catch(()=>({}));
        payoutReady = connected && Array.isArray(customer.disbursement_methods) && customer.disbursement_methods.length > 0;
      }
    } catch {}
    cached = {ok:true, policy:ESCROW_POLICY, environment:sandbox ? 'sandbox' : 'live', connected, payoutReady,
      message:!connected ? 'Escrow payments are being set up. Checkout is unavailable until the provider connection is verified.'
        : !payoutReady ? 'Escrow payments are finishing setup. Checkout will be available after 6ixo completes its payout setup.' : ''};
    expires = Date.now() + 60000;
  }
  const payload = req.method === 'POST' ? await req.json().catch(()=>({})) : {};
  // A fee calculation only; it creates no customer, transaction, payment or invitation.
  if (payload?.action === 'fee-preview' && cached.connected) {
    if (!feeExample) {
      try {
        const urls=providerUrls(base);
        const quote=transactionPayload({price:1000,currency:'CAD',title:'Fee calculation only',category:'electronics'},'buyer@6ixo.invalid','seller@6ixo.invalid','fee-example');
        const response=await fetch(`${urls.api}/transaction/fees-summary`,{method:'POST',headers:{Authorization:`Basic ${btoa(`${email}:${key}`)}`,'Content-Type':'application/json'},
          body:JSON.stringify({currency:quote.currency,items:quote.items,parties:quote.parties}),signal:AbortSignal.timeout(6000)});
        const result=await response.json().catch(()=>({}));
        feeExample={available:response.ok,providerStatus:response.status,amount:1000,serviceFee:20,
          estimatedTotal:Number.isFinite(Number(result.buyer_price)) ? Number(result.buyer_price) : null,
          brokerProceeds:Number.isFinite(Number(result.broker_proceeds)) ? Number(result.broker_proceeds) : null};
      } catch {feeExample={available:false};}
    }
    return new Response(JSON.stringify({...cached,feeExample}),{headers});
  }
  return new Response(JSON.stringify(cached), {headers});
});
