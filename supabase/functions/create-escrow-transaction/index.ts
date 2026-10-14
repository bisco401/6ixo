import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { createEscrowHandler } from '../_shared/escrow-backend.ts';
const admin = createClient(Deno.env.get('SUPABASE_URL') || '',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '');
Deno.serve(createEscrowHandler(admin,{
  email:Deno.env.get('ESCROW_API_EMAIL') || '',key:Deno.env.get('ESCROW_API_KEY') || '',
  base:Deno.env.get('ESCROW_API_BASE_URL') || 'https://api.escrow-sandbox.com/2017-09-01',
}));
