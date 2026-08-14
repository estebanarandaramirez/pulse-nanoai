import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { createClient } from 'npm:@supabase/supabase-js@2';

const CLORE_BASE = 'https://api.clore.ai/v1';

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

  const { data: gpuRow } = await sb
    .from('gpus')
    .select('active_platform, clore_server_id, node_id')
    .eq('gpu_id', gpu_id)
    .eq('user_email', user.email)
    .single();

  if (!gpuRow) return Response.json({ error: 'GPU not found' }, { status: 404 });

  const platform = (gpuRow.active_platform ?? '').toLowerCase();
  let platform_delete: { success: boolean; message?: string; skipped?: boolean } = { success: true, skipped: true };

  // OctaSpace: use the existing web crawler to delete the node on cube.octa.computer
  if (platform.includes('octa') && gpuRow.node_id) {
    try {
      const res = await base44.functions.invoke('autoClaimOctaNode', {
        node_id: String(gpuRow.node_id),
        delete_node: true,
      });
      platform_delete = { success: res.data?.success ?? false, message: res.data?.message };
    } catch (e: any) {
      platform_delete = { success: false, message: `OctaSpace crawler error: ${e.message}` };
    }
  } else if (platform.includes('octa') && !gpuRow.node_id) {
    platform_delete = { success: true, skipped: true, message: 'No node_id stored — removed from Pulse only' };

  // Clore.ai: call the hosting API to remove the server
  } else if (platform.includes('clore')) {
    if (gpuRow.clore_server_id) {
      const apiKey = Deno.env.get('CLOREAI_API_KEY');
      if (apiKey) {
        try {
          const delRes = await fetch(`${CLORE_BASE}/my_servers/${gpuRow.clore_server_id}`, {
            method: 'DELETE',
            headers: { 'auth': apiKey },
          });
          const body = await delRes.json().catch(() => ({}));
          platform_delete = {
            success: delRes.ok || body.code === 0,
            message: body.message ?? `HTTP ${delRes.status}`,
          };
        } catch (e: any) {
          platform_delete = { success: false, message: `Clore API error: ${e.message}` };
        }
      } else {
        platform_delete = { success: false, message: 'CLOREAI_API_KEY not configured' };
      }
    } else {
      platform_delete = { success: true, skipped: true, message: 'No server_id stored — removed from Pulse only' };
    }
  }

  // Remove from Supabase regardless of platform result
  const { error } = await sb
    .from('gpus')
    .delete()
    .eq('gpu_id', gpu_id)
    .eq('user_email', user.email);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true, platform_delete });
});
