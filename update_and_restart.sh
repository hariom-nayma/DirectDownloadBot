#!/bin/bash
echo "🔄 Starting Full Bot Update and API Restart..."

# 1. Update code
echo "📥 Pulling latest code..."
git pull

# 2. Cleanup (Ensures fresh start with correct permissions)
echo "🧹 Cleaning up old data folders..."
sudo rm -rf tg-data/*

# 3. Ensure restart script is executable
chmod +x restart_telegram_api.sh

# 4. Restart Local API Server
./restart_telegram_api.sh

# 5. Restart the Bot
echo "🤖 Restarting Telegram Bot (PM2)..."
pm2 restart tg-bot

echo ""
echo "✨ Update Complete! ✨"
echo "Monitor logs with: pm2 logs tg-bot"
