#!/bin/bash

# Configuration
API_ID=31222358
API_HASH=0d3d30daabb8403072ab86d3f0a1dc35
PORT=8081
CONTAINER_NAME="telegram-bot-api"
IMAGE="aiogram/telegram-bot-api:latest"
DATA_DIR="$(pwd)/tg-data"
BOT_TOKEN="8294062867:AAHShbknrcrBB4bsJsQdMpwQoxq7Ms6jcMM"

echo "🚀 Restarting Telegram Bot API Server..."

# 1. Stop and Remove existing container
echo "Stopping/Removing existing container if it exists..."
docker stop $CONTAINER_NAME 2>/dev/null
docker rm $CONTAINER_NAME 2>/dev/null

# 2. Prepare Data Directory
echo "Preparing data directory at $DATA_DIR"
mkdir -p "$DATA_DIR"
# Ensure it's writable by all (Docker runs as root inside)
sudo chmod -R 777 "$DATA_DIR"

# 3. Start the container
echo "Starting $IMAGE..."
# Using explicit flags to ensure credentials and local mode are active
docker run -d \
  --name $CONTAINER_NAME \
  -p $PORT:$PORT \
  -v "$DATA_DIR":/var/lib/telegram-bot-api \
  -e TELEGRAM_API_ID=$API_ID \
  -e TELEGRAM_API_HASH=$API_HASH \
  -e TELEGRAM_LOCAL=1 \
  $IMAGE \
  --api-id=$API_ID \
  --api-hash=$API_HASH \
  --local \
  --http-port=$PORT \
  --dir=/var/lib/telegram-bot-api \
  --max-download-file-size=2000000000 \
  --max-upload-file-size=2000000000

# 4. Wait for healthy response
echo "Waiting for API to initialize (max 20s)..."
MAX_RETRIES=20
COUNT=0
READY=0

while [ $COUNT -lt $MAX_RETRIES ]; do
    # Try a simple getMe to see if the server is up AND knows our bot
    RESPONSE=$(curl -s "http://localhost:$PORT/bot$BOT_TOKEN/getMe")
    if [[ "$RESPONSE" == *"\"ok\":true"* ]]; then
        echo "✅ API Server is READY and Authenticated!"
        READY=1
        break
    fi
    echo "⌛ Waiting... ($((MAX_RETRIES - COUNT))s left)"
    sleep 1
    COUNT=$((COUNT + 1))
done

if [ $READY -eq 1 ]; then
    echo "✅ Success! PM2 bot can be restarted safely now."
    echo "📋 Logs Tail:"
    docker logs --tail 5 $CONTAINER_NAME
else
    echo "❌ API Server failed to respond correctly after ${MAX_RETRIES}s."
    echo "📋 Last response: $RESPONSE"
    echo "📋 Docker Logs:"
    docker logs $CONTAINER_NAME
    exit 1
fi