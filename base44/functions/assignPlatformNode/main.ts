/**
 * assignPlatformNode
 * Links a registered Pulse GPU record to a platform-specific node/server ID.
 * Saves platform_node_id to both base44 entity and Supabase gpus table.
 *
 * Input:  { gpu_base44_id, platform_node_id, platform }
 * Output: { success, gpu_base44_id, platform_node_id }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { gpu_base44_id, platform_node_id, platform } = await req.json();
  if (!gpu_base44_id || !platform_node_id) {
    return Response.json({ error: 'gpu_base44_id and platform_node_id are required' }, { status: 400 });
  }

  const nodeIdStr = String(platform_node_id);

  try {
    await base44.entities.GPU.update(gpu_base44_id, {
      platform_node_id: nodeIdStr,
      ...(platform ? { platform } : {}),
    });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (supabaseUrl && supabaseKey) {
      const { createClient } = await import('npm:@supabase/supabase-js@2');
      const sb = createClient(supabaseUrl, supabaseKey);
      await sb.from('gpus')
        .update({ platform_node_id: nodeIdStr, ...(platform ? { platform } : {}) })
        .eq('base44_id', gpu_base44_id);
    }

    return Response.json({ success: true, gpu_base44_id, platform_node_id: nodeIdStr });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
