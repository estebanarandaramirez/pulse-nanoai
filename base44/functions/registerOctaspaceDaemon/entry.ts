/**
 * registerOctaspaceDaemon
 * Called by pulse-octa-setup.bat after OctaSpace OSN installation.
 * Creates or updates the GPU record in Supabase and stores the node token so
 * the Pulse dashboard can track this machine's earnings.
 *
 * Input: { gpu_model, vram_gb, octa_node_token, platform }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { createClient } from 'npm:@supabase/supabase-js@2';

function estimateGrossRate(vramGb: number): number {
  if (vramGb >= 80) return 1.50;
  if (vramGb >= 40) return 0.80;
  if (vramGb >= 24) return 0.45;
  if (vramGb >= 16) return 0.30;
  return 0.20;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseKey) {
    return Response.json({ error: 'Supabase not configured' }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const body = await req.json();
  const { gpu_model, vram_gb, octa_node_token, platform = 'OctaSpace', location } = body;

  if (!gpu_model || !vram_gb) {
    return Response.json({ error: 'gpu_model and vram_gb are required' }, { status: 400 });
  }

  const vram = parseInt(vram_gb, 10);
  const ratePerHour = estimateGrossRate(vram);
  const userRateHr = parseFloat((ratePerHour * 0.6).toFixed(4));
  const nodeToken = octa_node_token?.toString().trim() ?? '';
  const suffix = nodeToken ? nodeToken.slice(-6).toUpperCase() : Math.random().toString(36).slice(2, 8).toUpperCase();
  const gpu_id = `OCTA-${gpu_model.replace(/[^a-zA-Z0-9]/g, '')}-${suffix}`;

  try {
    // Check for existing GPU: match on node token if provided, else user+model+platform
    const existingQuery = nodeToken
      ? supabase.from('gpus').select('*').eq('user_email', user.email).eq('octa_node_token', nodeToken)
      : supabase.from('gpus').select('*').eq('user_email', user.email).eq('model', gpu_model).eq('active_platform', 'OctaSpace');

    const { data: existing } = await existingQuery;

    let gpuRecord: any;
    if (existing && existing.length > 0) {
      const { data: updated } = await supabase
        .from('gpus')
        .update({
          last_heartbeat: new Date().toISOString(),
          status: 'active',
          rate_per_hour: userRateHr,
          active_platform: platform,
          ...(nodeToken ? { octa_node_token: nodeToken } : {}),
        })
        .eq('id', existing[0].id)
        .select()
        .single();
      gpuRecord = updated ?? existing[0];
    } else {
      const { data: created, error: createErr } = await supabase
        .from('gpus')
        .insert({
          gpu_id,
          model: gpu_model,
          vram_gb: vram,
          status: 'active',
          rate_per_hour: userRateHr,
          uptime_percent: 100,
          total_earned_usd: 0,
          pls_minted: 0,
          location: location || 'Unknown',
          last_heartbeat: new Date().toISOString(),
          user_email: user.email,
          octa_node_token: nodeToken,
          active_platform: platform,
        })
        .select()
        .single();
      if (createErr) throw new Error(createErr.message);
      gpuRecord = created;
    }

    // Auto-claim the node on cube.octa.computer
    let claimResult: any = null;
    if (nodeToken) {
      try {
        const claimRes = await base44.functions.invoke('autoClaimOctaNode', {
          node_token: nodeToken,
          node_name: gpuRecord.gpu_id,
        });
        claimResult = claimRes.data;
      } catch (e: any) {
        console.error('autoClaimOctaNode failed:', e.message);
        claimResult = { success: false, message: e.message };
      }
    }

    return Response.json({
      success: true,
      gpu_id: gpuRecord.gpu_id,
      gpu_model,
      vram_gb: vram,
      octa_node_token: nodeToken,
      active_platform: platform,
      user_rate_hr: userRateHr,
      gross_rate_hr: ratePerHour,
      pulse_share_pct: 40,
      daily_est_usd: parseFloat((userRateHr * 24 * 0.9).toFixed(2)),
      monthly_est_usd: parseFloat((userRateHr * 24 * 0.9 * 30).toFixed(2)),
      cube_claim: claimResult,
      message: `GPU registered on OctaSpace via Pulse. Earning $${userRateHr}/hr (60% of $${ratePerHour}/hr est. gross).`,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
