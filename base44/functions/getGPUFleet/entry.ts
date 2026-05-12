import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      return Response.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const userEmail = body.user_email;

    let query = supabase.from('gpus').select('*').order('last_heartbeat', { ascending: false });
    if (userEmail) query = query.eq('user_email', userEmail);

    const { data, error } = await query;

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ gpus: data || [] });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});