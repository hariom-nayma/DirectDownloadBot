#!/bin/bash
echo "🔄 Starting Full Bot Update and API Restart..."

# 1. Update code - Forceful to handle VPS conflicts
echo "📥 Syncing code with repository..."
git fetch --all
git reset --hard origin/main

# 2. Cleanup (Ensures fresh start with correct permissions)
echo "🧹 Cleaning up old data folders..."
sudo rm -rf tg-data/*

# 3. Ensure scripts are executable
chmod +x restart_telegram_api.sh
chmod +x update_and_restart.sh

# 4. Restart Local API Server
./restart_telegram_api.sh

# 5. Restart the Bot
echo "🤖 Restarting Telegram Bot (PM2)..."
pm2 restart tg-bot

echo ""
echo "✨ Update Complete! ✨"
echo "Monitor logs with: pm2 logs tg-bot"
