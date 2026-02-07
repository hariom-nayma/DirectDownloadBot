#!/bin/bash

# Configuration
API_ID=31222358
API_HASH=0d3d30daabb8403072ab86d3f0a1dc35
PORT=8081
CONTAINER_NAME="telegram-bot-api"
IMAGE="aiogram/telegram-bot-api:latest"
DATA_DIR="$(pwd)/tg-data"
# Identify the current host user
HOST_USER=$(whoami)
# Bot token for health check (Internal use only)
BOT_TOKEN="8294062867:AAHShbknrcrBB4bsJsQdMpwQoxq7Ms6jcMM"

echo "🚀 Restarting Telegram Bot API Server..."

# 1. Stop and Remove existing container
echo "Stopping/Removing existing container if it exists..."
docker stop $CONTAINER_NAME 2>/dev/null
docker rm $CONTAINER_NAME 2>/dev/null

# 2. Prepare Data Directory
echo "Preparing data directory at $DATA_DIR"
mkdir -p "$DATA_DIR"
# Force initial ownership and world-writable permissions
sudo chown -R $HOST_USER:$HOST_USER "$DATA_DIR"
sudo chmod -R 777 "$DATA_DIR"

# 3. Apply Total-Access ACLs (Industrial Strength Fix)
echo "🛡️  Applying Aggressive ACL Masking for $HOST_USER..."
if ! command -v setfacl &> /dev/null; then
    echo "📥 Installing 'acl' package..."
    sudo apt-get update -qq && sudo apt-get install -y -qq acl
fi

if command -v setfacl &> /dev/null; then
    # -R: Recursive
    # -d: Default (applies to future files/folders)
    # -m: Modify
    # u::rwx,g::rwx,o::rwx: Base permissions
    # m::rwx: FORCE the mask to be rwx (overrides Docker's restrictive subfolder creation)
    # u:$HOST_USER:rwx: Explicitly give the host user full access
    sudo setfacl -R -m u::rwx,g::rwx,o::rwx,m::rwx "$DATA_DIR"
    sudo setfacl -R -d -m u::rwx,g::rwx,o::rwx,m::rwx "$DATA_DIR"
    sudo setfacl -R -m u:$HOST_USER:rwx,d:u:$HOST_USER:rwx "$DATA_DIR"
    echo "✅ Aggressive ACLs applied. Every new file will be world-accessible."
else
    echo "⚠️  ACLs failed. Bot may face EACCES on new folders."
fi

# 4. Start the container
echo "Starting $IMAGE..."
# Run as root so it can initialize its internal databases and directories.
# Our host ACLs will handle the permissions for the bot.
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
  --max-download-file-size=4000000000 \
  --max-upload-file-size=4000000000

# 5. Wait for healthy response
echo "Waiting for API to initialize (max 20s)..."
MAX_RETRIES=20
COUNT=0
READY=0
# Use 127.0.0.1 for the internal curl health check
while [ $COUNT -lt $MAX_RETRIES ]; do
    RESPONSE=$(curl -s "http://127.0.0.1:$PORT/bot$BOT_TOKEN/getMe")
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
    # Final cleanup just in case
    sudo chmod -R 777 "$DATA_DIR" 2>/dev/null
    echo "✅ Success! API Server is active."
else
    echo "❌ API Server failed to respond correctly after ${MAX_RETRIES}s."
    exit 1
fi