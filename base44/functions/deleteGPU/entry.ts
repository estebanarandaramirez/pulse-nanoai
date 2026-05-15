import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { gpu_id } = await req.json().catch(() => ({}));
  if (!gpu_id) return Response.json({ error: 'gpu_id required' }, { status: 400 });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseKey)
    return Response.json({ error: 'Supabase not configured' }, { status: 500 });

  const sb = createClient(supabaseUrl, supabaseKey);

  // Only allow deleting GPUs owned by the requesting user
  const { error } = await sb
    .from('gpus')
    .delete()
    .eq('gpu_id', gpu_id)
    .eq('user_email', user.email);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ success: true });
});
