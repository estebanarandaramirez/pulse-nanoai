/**
 * generateGPUDaemon
 * Generates a Python daemon script that detects GPU and reports to platform
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { platform_preference = 'runpod' } = body;

  // Generate the daemon script
  const daemonScript = `#!/usr/bin/env python3
"""
PULSE NanoAI GPU Daemon
Auto-detects GPU and reports to platform every 5 minutes
"""
import subprocess
import json
import time
import uuid
import os
from urllib.request import urlopen, Request
from urllib.error import URLError

DAEMON_ID = "${user.email.replace('@', '_').replace('.', '_')}_" + str(uuid.uuid4())[:8]
PLATFORM_API = "https://api.base44.app"
USER_TOKEN = "${user.email}"  # Replace with actual auth token
PLATFORM = "${platform_preference}"
CHECK_INTERVAL = 300  # 5 minutes

def get_gpu_info():
    """Detect GPU using nvidia-smi or similar"""
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            lines = result.stdout.strip().split('\\n')
            gpus = []
            for line in lines:
                parts = line.split(',')
                if len(parts) == 2:
                    model = parts[0].strip()
                    vram_mb = int(parts[1].strip().split()[0])
                    vram_gb = vram_mb / 1024
                    gpus.append({'model': model, 'vram_gb': vram_gb})
            return gpus
    except Exception as e:
        print(f"[ERROR] GPU detection failed: {e}")
    return []

def get_uptime():
    """Get system uptime percentage (simplified)"""
    try:
        result = subprocess.run(['uptime', '-p'], capture_output=True, text=True)
        return 95.0  # Placeholder
    except:
        return 90.0

def register_gpu(gpu_info):
    """Register GPU with platform"""
    payload = {
        'gpu_model': gpu_info['model'],
        'vram_gb': gpu_info['vram_gb'],
        'location': 'Unknown',
        'platform_preference': PLATFORM,
        'daemon_id': DAEMON_ID,
        'uptime_percent': get_uptime(),
    }
    
    try:
        req = Request(
            f'{PLATFORM_API}/functions/registerGPUDaemon',
            data=json.dumps(payload).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {USER_TOKEN}'
            }
        )
        with urlopen(req, timeout=10) as response:
            result = json.loads(response.read())
            print(f"[OK] GPU registered: {result.get('gpu_id')}")
            return True
    except URLError as e:
        print(f"[ERROR] Registration failed: {e}")
        return False

def main():
    print("[START] PULSE NanoAI GPU Daemon")
    print(f"[INFO] Daemon ID: {DAEMON_ID}")
    print(f"[INFO] Platform: {PLATFORM}")
    print(f"[INFO] Check interval: {CHECK_INTERVAL}s")
    
    while True:
        gpus = get_gpu_info()
        if gpus:
            print(f"[INFO] Found {len(gpus)} GPU(s)")
            for gpu in gpus:
                register_gpu(gpu)
        else:
            print("[WARN] No GPUs detected")
        
        time.sleep(CHECK_INTERVAL)

if __name__ == '__main__':
    main()
`;

  return new Response(daemonScript, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
      'Content-Disposition': 'attachment; filename="pulse_gpu_daemon.py"',
    },
  });
});