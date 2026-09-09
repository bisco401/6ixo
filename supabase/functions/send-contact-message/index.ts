import { createContactHandler } from './handler.ts';

Deno.serve(createContactHandler({
  supabaseUrl: String(Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, ''),
  serviceRoleKey: String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim(),
  resendApiKey: String(Deno.env.get('RESEND_API_KEY') || '').trim(),
  sender: String(Deno.env.get('HOST_EMAIL_FROM') || '6ixo <noreply@6ixo.com>').trim(),
}));
