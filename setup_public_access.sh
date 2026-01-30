#!/bin/bash

echo "🌐 Setting up Public Access for Direct Download Links..."

# Get public IP
echo "🔍 Detecting your server's public IP..."
PUBLIC_IP=$(curl -s ifconfig.me)

if [ -z "$PUBLIC_IP" ]; then
    echo "❌ Could not detect public IP. Please check your internet connection."
    exit 1
fi

echo "✅ Detected Public IP: $PUBLIC_IP"

# Update .env file
echo "📝 Updating .env file..."
sed -i "s/YOUR_PUBLIC_IP/$PUBLIC_IP/g" .env

# Show the updated configuration
echo "📋 Updated configuration:"
grep "TELEGRAM_API_URL" .env

# Check if port 8081 is accessible
echo ""
echo "🔒 Checking firewall configuration..."
if command -v ufw &> /dev/null; then
    echo "UFW Status:"
    sudo ufw status | grep 8081 || echo "Port 8081 not found in UFW rules"
    echo ""
    echo "💡 To allow external access, run:"
    echo "sudo ufw allow 8081"
elif command -v firewall-cmd &> /dev/null; then
    echo "Firewalld Status:"
    sudo firewall-cmd --list-ports | grep 8081 || echo "Port 8081 not found in firewall rules"
    echo ""
    echo "💡 To allow external access, run:"
    echo "sudo firewall-cmd --permanent --add-port=8081/tcp"
    echo "sudo firewall-cmd --reload"
else
    echo "⚠️ No firewall detected or unknown firewall system"
fi

echo ""
echo "🔧 Next steps:"
echo "1. Open port 8081 in your firewall (see commands above)"
echo "2. Restart your bot: pm2 restart direct-link-bot"
echo "3. Test with a new file upload and /link command"
echo ""
echo "🌍 Your direct download links will now be accessible from:"
echo "http://$PUBLIC_IP:8081/file/bot.../..."