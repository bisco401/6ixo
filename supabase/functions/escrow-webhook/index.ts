import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { escrowBackend } from '../_shared/escrow-backend.ts';
const admin = createClient(Deno.env.get('SUPABASE_URL') || '',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '');
const secret = Deno.env.get('ESCROW_WEBHOOK_TOKEN') || '';
const backend = escrowBackend(admin,{
  email:Deno.env.get('ESCROW_API_EMAIL') || '',key:Deno.env.get('ESCROW_API_KEY') || '',
  base:Deno.env.get('ESCROW_API_BASE_URL') || 'https://api.escrow-sandbox.com/2017-09-01',
});
Deno.serve(async(req)=>{
  const headers = {'Content-Type':'application/json'};
  if (req.method !== 'POST') return new Response('{}',{status:405,headers});
  const token = new URL(req.url).searchParams.get('token') || req.headers.get('x-escrow-webhook-token') || '';
  if (!secret || token !== secret) return new Response('{}',{status:401,headers});
  try {
    const payload = await req.json();
    const id = String(payload.transaction_id || '');
    if (payload.event_type !== 'transaction' || !/^\d+$/.test(id)) return new Response('{}',{status:400,headers});
    const {data,error} = await admin.from('escrow_transactions').select().eq('escrow_transaction_id',id).maybeSingle();
    if (error) throw error;
    // Event names are notifications, never proof of payment. Re-fetch and verify the actual provider transaction.
    if (data) await backend.refresh(data);
    return new Response(JSON.stringify({ok:true}),{headers});
  } catch { return new Response(JSON.stringify({error:'Unable to verify the provider event. Retry required.'}),{status:503,headers}); }
});
