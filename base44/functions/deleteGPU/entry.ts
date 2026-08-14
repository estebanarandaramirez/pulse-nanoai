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

  // Fetch the record first so we can return platform-specific cleanup notes
  const { data: gpuRow } = await sb
    .from('gpus')
    .select('active_platform, clore_server_id, node_id')
    .eq('gpu_id', gpu_id)
    .eq('user_email', user.email)
    .single();

  if (!gpuRow) return Response.json({ error: 'GPU not found' }, { status: 404 });

  const { error } = await sb
    .from('gpus')
    .delete()
    .eq('gpu_id', gpu_id)
    .eq('user_email', user.email);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const platform = (gpuRow.active_platform ?? '').toLowerCase();
  const octa_manual_required = platform === 'octaspace';
  const platform_note = octa_manual_required
    ? 'Node removed from Pulse. You must also manually delete it on cube.octa.computer — skip this and re-registering will fail with a stale token.'
    : 'Server removed from Pulse. To fully remove it from Clore.ai, uninstall the hosting agent on the machine.';

  return Response.json({ success: true, octa_manual_required, platform_note });
});
