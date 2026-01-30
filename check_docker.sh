#!/bin/bash

echo "=== Docker Container Analysis ==="
echo "Container Status:"
docker ps | grep telegram-bot-api

echo -e "\n=== Volume Mounts ==="
docker inspect telegram-bot-api | grep -A 10 "Mounts"

echo -e "\n=== Container Configuration ==="
docker inspect telegram-bot-api | grep -A 5 "Cmd"

echo -e "\n=== Recommended Fix ==="
echo "If no volume mounts found, restart with:"
echo "docker stop telegram-bot-api"
echo "docker rm telegram-bot-api"
echo ""
echo "docker run -d \\"
echo "  --name telegram-bot-api \\"
echo "  -p 8081:8081 \\"
echo "  -v telegram-bot-api-data:/var/lib/telegram-bot-api \\"
echo "  -e TELEGRAM_API_ID=your_api_id \\"
echo "  -e TELEGRAM_API_HASH=your_api_hash \\"
echo "  aiogram/telegram-bot-api:latest \\"
echo "  --local"