#!/bin/bash

# Configuration
API_ID=31222358
API_HASH=0d3d30daabb8403072ab86d3f0a1dc35
PORT=8081
CONTAINER_NAME="telegram-bot-api"
IMAGE="aiogram/telegram-bot-api:latest"
DATA_DIR="$(pwd)/tg-data"

echo "🚀 Restarting Telegram Bot API Server..."

# 1. Stop and Remove existing container
echo "Stopping/Removing existing container if it exists..."
docker stop $CONTAINER_NAME 2>/dev/null
docker rm $CONTAINER_NAME 2>/dev/null

# 2. Prepare Data Directory with ACLs
# This ensures that even if Docker (root) creates a folder, the host user (ubuntu) can read/write it.
echo "Preparing data directory at $DATA_DIR with ACLs..."
mkdir -p "$DATA_DIR"

# grant current user full access and make it default for new files
if command -v setfacl &> /dev/null; then
    echo "Applying ACLs to $DATA_DIR"
    sudo setfacl -R -m d:u:$(id -u):rwx "$DATA_DIR"
    sudo setfacl -R -m u:$(id -u):rwx "$DATA_DIR"
    sudo setfacl -R -m d:o:rwx "$DATA_DIR"
    sudo setfacl -R -m o:rwx "$DATA_DIR"
else
    echo "⚠️ setfacl not found, falling back to chmod 777"
    sudo chmod -R 777 "$DATA_DIR"
fi

# 3. Start the container
echo "Starting $IMAGE..."
docker run -d \
  --name $CONTAINER_NAME \
  -p $PORT:$PORT \
  -v "$DATA_DIR":/var/lib/telegram-bot-api \
  -e TELEGRAM_API_ID=$API_ID \
  -e TELEGRAM_API_HASH=$API_HASH \
  -e TELEGRAM_LOCAL=1 \
  -e TELEGRAM_MAX_DOWNLOAD_FILE_SIZE=2000000000 \
  -e TELEGRAM_MAX_UPLOAD_FILE_SIZE=2000000000 \
  $IMAGE \
  telegram-bot-api \
  --api-id=$API_ID \
  --api-hash=$API_HASH \
  --local \
  --http-port=$PORT \
  --dir=/var/lib/telegram-bot-api \
  --max-download-file-size=2000000000

# 4. Wait and Verify
echo "Waiting for container to start (5s)..."
sleep 5

if docker ps | grep -q $CONTAINER_NAME; then
    echo "✅ Container is running!"
    # One last recursive chmod just in case ACLs failed for existing root-owned folders
    sudo chmod -R 777 "$DATA_DIR" 2>/dev/null
    
    echo "📋 Logs:"
    docker logs --tail 10 $CONTAINER_NAME
    echo "🧪 Testing API Connection..."
    if curl -s "http://localhost:$PORT" > /dev/null; then
        echo "✅ API Port $PORT is responding!"
    else
        echo "⚠️ API Port $PORT is NOT responding yet. Check logs!"
    fi
else
    echo "❌ Container FAILED to start. Check logs with: docker logs $CONTAINER_NAME"
    docker ps -a | grep $CONTAINER_NAME
fi