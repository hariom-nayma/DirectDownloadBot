#!/bin/bash

echo "=== Docker Container Analysis ==="
echo "Container Status:"
docker ps | grep telegram-bot-api

echo -e "\n=== Environment Variables ==="
echo "Checking API credentials..."
docker exec telegram-bot-api env | grep -E "TELEGRAM_API_ID|TELEGRAM_API_HASH" || echo "No API credentials found in environment"

echo -e "\n=== Volume Mounts ==="
docker inspect telegram-bot-api | grep -A 10 "Mounts"

echo -e "\n=== Container Configuration ==="
docker inspect telegram-bot-api | grep -A 5 "Cmd"

echo -e "\n=== Full Environment Check ==="
echo "All environment variables:"
docker exec telegram-bot-api env | sort

echo -e "\n=== Container Inspect (Environment Section) ==="
docker inspect telegram-bot-api | jq '.[0].Config.Env' 2>/dev/null || docker inspect telegram-bot-api | grep -A 20 '"Env"'

echo -e "\n=== Recommended Fix ==="
echo "If no volume mounts found, restart with:"
echo "docker stop telegram-bot-api"
echo "docker rm telegram-bot-api"
echo ""
echo "docker run -d \\"
echo "  --name telegram-bot-api \\"
echo "  -p 8081:8081 \\"
echo "  -v telegram-bot-api-data:/var/lib/telegram-bot-api \\"
echo "  -e TELEGRAM_API_ID=31222358 \\"
echo "  -e TELEGRAM_API_HASH=0d3d30daabb8403072ab86d3f0a1dc35 \\"
echo "  aiogram/telegram-bot-api:latest \\"
echo "  --local"