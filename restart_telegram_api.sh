#!/bin/bash

echo "🔄 Restarting Telegram Bot API Server with Full Configuration..."

# Stop and remove existing container
echo "Stopping existing container..."
docker stop telegram-bot-api 2>/dev/null || echo "No container to stop"
docker rm telegram-bot-api 2>/dev/null || echo "No container to remove"

# Start new container with full configuration
echo "Starting new container with complete API configuration..."
docker run -d \
  --name telegram-bot-api \
  -p 8081:8081 \
  -v telegram-bot-api-data:/var/lib/telegram-bot-api \
  -e TELEGRAM_API_ID=31222358 \
  -e TELEGRAM_API_HASH=0d3d30daabb8403072ab86d3f0a1dc35 \
  aiogram/telegram-bot-api:latest \
  --api-id=31222358 \
  --api-hash=0d3d30daabb8403072ab86d3f0a1dc35 \
  --local \
  --http-port=8081

# Wait for container to start
echo "Waiting for container to start..."
sleep 5

# Check if it started successfully
if docker ps | grep -q telegram-bot-api; then
    echo "✅ Container started successfully!"
    echo ""
    echo "📊 Container Status:"
    docker ps | grep telegram-bot-api
    echo ""
    echo "🔐 API Credentials Check:"
    docker exec telegram-bot-api env | grep -E "TELEGRAM_API_ID|TELEGRAM_API_HASH"
    echo ""
    echo "📋 Container Logs (last 10 lines):"
    docker logs --tail 10 telegram-bot-api
    echo ""
    echo "🧪 Testing API Endpoint:"
    curl -s "http://localhost:8081/bot8294062867:AAHShbknrcrBB4bsJsQdMpwQoxq7Ms6jcMM/getMe" | jq . || curl -s "http://localhost:8081/bot8294062867:AAHShbknrcrBB4bsJsQdMpwQoxq7Ms6jcMM/getMe"
    echo ""
    echo "🔗 Testing File Serving:"
    echo "Upload a file to your bot and try /link to test file serving"
else
    echo "❌ Container failed to start!"
    echo "📋 Error logs:"
    docker logs telegram-bot-api
fi