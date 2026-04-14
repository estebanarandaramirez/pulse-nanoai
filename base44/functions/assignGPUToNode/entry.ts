/**
 * assignGPUToNode
 * Assigns a registered GPU to the next available node pool.
 * Creates a new node if no open slot exists.
 *
 * A node targets ~1000 GPUs and is rented to a platform as a unit.
 * Revenue is tracked per GPU by the platform; Pulse distributes
 * 60% to the GPU owner and retains 40%.
 *
 * Input:  { gpu_record_id }
 * Output: { node_id, node_name, gpu_count, target_gpu_count, platform }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const TARGET_NODE_SIZE = 1000;
const ACTIVE_PLATFORM = 'Salad';

function generateNodeId(): string {
  return `NODE-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function generateNodeName(existingCount: number): string {
  const names = [
    'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon',
    'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa',
    'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron',
  ];
  const name = names[existingCount % names.length] ?? `Node-${existingCount + 1}`;
  return `Node ${name}`;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { gpu_record_id } = await req.json();
  if (!gpu_record_id) {
    return Response.json({ error: 'gpu_record_id required' }, { status: 400 });
  }

  try {
    // --- Find a node with open capacity ---
    const openNodes = await base44.entities.Node.filter({ status: 'filling' });

    let targetNode: any = null;

    if (openNodes && openNodes.length > 0) {
      // Pick the node with the most GPUs (consolidate nodes before opening new ones)
      targetNode = openNodes.sort((a: any, b: any) => (b.gpu_count ?? 0) - (a.gpu_count ?? 0))[0];
    }

    if (!targetNode) {
      // No open node — create one
      const allNodes = await base44.entities.Node.list('-created_date', 1);
      const nodeCount = allNodes?.length ?? 0;

      targetNode = await base44.entities.Node.create({
        node_id: generateNodeId(),
        name: generateNodeName(nodeCount),
        platform: ACTIVE_PLATFORM,
        status: 'filling',
        gpu_count: 0,
        target_gpu_count: TARGET_NODE_SIZE,
        total_earnings_usd: 0,
        daily_earnings_usd: 0,
      });
    }

    const currentCount = targetNode.gpu_count ?? 0;
    const newCount = currentCount + 1;
    const isFull = newCount >= (targetNode.target_gpu_count ?? TARGET_NODE_SIZE);

    // --- Update node GPU count and status ---
    await base44.entities.Node.update(targetNode.id, {
      gpu_count: newCount,
      status: isFull ? 'active' : 'filling',
    });

    // --- Tag the GPU with its node ---
    await base44.entities.GPU.update(gpu_record_id, {
      node_id: targetNode.node_id,
    });

    return Response.json({
      success: true,
      node_id: targetNode.node_id,
      node_name: targetNode.name,
      platform: targetNode.platform,
      gpu_count: newCount,
      target_gpu_count: targetNode.target_gpu_count ?? TARGET_NODE_SIZE,
      fill_percent: Math.round((newCount / (targetNode.target_gpu_count ?? TARGET_NODE_SIZE)) * 100),
      status: isFull ? 'active' : 'filling',
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
