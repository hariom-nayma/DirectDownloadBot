#!/bin/bash

echo "🔄 Trying Official Telegram Bot API Server..."

# Stop and remove existing container
echo "Stopping existing container..."
docker stop telegram-bot-api 2>/dev/null || echo "No container to stop"
docker rm telegram-bot-api 2>/dev/null || echo "No container to remove"

# Try the official Telegram Bot API server
echo "Starting official Telegram Bot API server..."
docker run -d \
  --name telegram-bot-api \
  -p 8081:8081 \
  -v telegram-bot-api-data:/var/lib/telegram-bot-api \
  -e TELEGRAM_API_ID=31222358 \
  -e TELEGRAM_API_HASH=0d3d30daabb8403072ab86d3f0a1dc35 \
  telegram-bot-api/telegram-bot-api:latest \
  --api-id=31222358 \
  --api-hash=0d3d30daabb8403072ab86d3f0a1dc35 \
  --local \
  --http-port=8081

# Wait for container to start
echo "Waiting for container to start..."
sleep 5

# Check if it started successfully
if docker ps | grep -q telegram-bot-api; then
    echo "✅ Official container started successfully!"
else
    echo "❌ Official container failed, trying aiogram with explicit --local..."
    
    # Fallback to aiogram with explicit command
    docker run -d \
      --name telegram-bot-api \
      -p 8081:8081 \
      -v telegram-bot-api-data:/var/lib/telegram-bot-api \
      -e TELEGRAM_API_ID=31222358 \
      -e TELEGRAM_API_HASH=0d3d30daabb8403072ab86d3f0a1dc35 \
      aiogram/telegram-bot-api:latest \
      telegram-bot-api \
      --api-id=31222358 \
      --api-hash=0d3d30daabb8403072ab86d3f0a1dc35 \
      --local \
      --http-port=8081 \
      --dir=/var/lib/telegram-bot-api
    
    sleep 5
fi

# Final check
if docker ps | grep -q telegram-bot-api; then
    echo "✅ Container is running!"
    echo ""
    echo "� Container Status:"
    docker ps | grep telegram-bot-api
    echo ""
    echo "📋 Container Logs:"
    docker logs --tail 15 telegram-bot-api
    echo ""
    echo "🧪 Testing API:"
    curl -s "http://localhost:8081/bot8294062867:AAHShbknrcrBB4bsJsQdMpwQoxq7Ms6jcMM/getMe" | jq .result.first_name || echo "API test failed"
else
    echo "❌ All attempts failed!"
    docker logs telegram-bot-api
fi