#!/bin/bash
set -e

echo "🚀 PULSE NanoAI GPU Daemon Installer"
echo "===================================="

# Check prerequisites
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Install from https://docs.docker.com/install/"
    exit 1
fi

if ! command -v nvidia-smi &> /dev/null; then
    echo "⚠️  nvidia-smi not found. NVIDIA GPU support may not work."
fi

# Read credentials
read -p "Enter your PULSE API token: " API_TOKEN
read -p "Enter your Phantom wallet address: " WALLET_ADDR
read -p "Enter platform preference (vast.ai|runpod|clore.ai|octaspace|auto): " PLATFORM

# Create directory
DAEMON_DIR="/opt/pulse-daemon"
sudo mkdir -p $DAEMON_DIR
cd $DAEMON_DIR

# Create .env file
cat > .env << EOF
API_TOKEN=$API_TOKEN
WALLET_ADDRESS=$WALLET_ADDR
PLATFORM_PREFERENCE=$PLATFORM
API_BASE_URL=https://api.pulse.ai
HEARTBEAT_INTERVAL=300
SOLANA_NETWORK=testnet
EOF

echo "✅ Configuration saved to .env"

# Download daemon from API
curl -s https://api.pulse.ai/v1/daemon/download \
    -H "Authorization: Bearer $API_TOKEN" \
    -o gpu_daemon.py

chmod +x gpu_daemon.py
echo "✅ Daemon script downloaded"

# Install systemd service (if Linux)
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    sudo cp /path/to/pulse-daemon.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable pulse-daemon
    sudo systemctl start pulse-daemon
    echo "✅ Systemd service installed and started"
    systemctl status pulse-daemon
fi

# Docker alternative
read -p "Run as Docker container instead? (y/n): " DOCKER_CHOICE
if [[ $DOCKER_CHOICE == "y" ]]; then
    docker run -d \
        --name pulse-daemon \
        --restart always \
        --gpus all \
        --env-file .env \
        -v $(pwd)/logs:/app/logs \
        pulse-daemon:latest
    echo "✅ Docker container running"
    docker logs -f pulse-daemon
fi

echo ""
echo "✅ Installation complete!"
echo "Monitor your GPU at: https://app.pulse.ai/gpu-fleet"