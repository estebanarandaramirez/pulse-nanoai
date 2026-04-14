/**
 * generateSetupScript
 * Generates a one-click setup script that installs and runs the GPU daemon
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { platform = 'runpod' } = body;

  const setupScript = `#!/bin/bash
# PULSE NanoAI - One-Click GPU Setup
# This script auto-detects your GPU and connects it to PULSE NanoAI

set -e

echo "======================================"
echo "PULSE NanoAI GPU Setup"
echo "======================================"
echo ""
echo "This script will:"
echo "  1. Detect your GPU"
echo "  2. Download the PULSE daemon"
echo "  3. Start earning immediately"
echo ""

# Check for nvidia-smi
if ! command -v nvidia-smi &> /dev/null; then
    echo "[ERROR] nvidia-smi not found. Please install NVIDIA drivers."
    exit 1
fi

echo "[INFO] Detecting GPU..."
GPU_INFO=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader)
echo "[OK] GPU detected: $GPU_INFO"

# Create pulse directory
PULSE_DIR="\$HOME/.pulse-nano-ai"
mkdir -p "\$PULSE_DIR"

echo "[INFO] Downloading PULSE daemon..."
# Download the Python daemon
curl -s "https://api.base44.app/functions/generateGPUDaemon" \\
  -H "Authorization: Bearer ${user.email}" \\
  -X POST \\
  -H "Content-Type: application/json" \\
  -d '{"platform_preference":"${platform}"}' \\
  > "\$PULSE_DIR/daemon.py"

chmod +x "\$PULSE_DIR/daemon.py"

echo "[INFO] Starting PULSE daemon..."
# Run daemon in background
nohup python3 "\$PULSE_DIR/daemon.py" > "\$PULSE_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
echo "\$DAEMON_PID" > "\$PULSE_DIR/daemon.pid"

echo ""
echo "======================================"
echo "✅ Setup Complete!"
echo "======================================"
echo ""
echo "Your GPU is now earning PULSE tokens."
echo "Daemon PID: \$DAEMON_PID"
echo "Logs: \$PULSE_DIR/daemon.log"
echo ""
echo "To stop the daemon:"
echo "  kill \$(cat \$PULSE_DIR/daemon.pid)"
echo ""
echo "Your email: ${user.email}"
echo "Platform: ${platform}"
echo ""
`;

  return new Response(setupScript, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
      'Content-Disposition': 'attachment; filename="pulse-setup.sh"',
    },
  });
});