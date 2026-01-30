#!/bin/bash

DOMAIN="download.hariom.site"
PUBLIC_IP=$(curl -s ifconfig.me)

echo "🌐 Setting up Professional Domain Access..."
echo "Domain: $DOMAIN"
echo "Server IP: $PUBLIC_IP"
echo ""

# Test DNS resolution
echo "🔍 Testing DNS resolution..."
RESOLVED_IP=$(dig +short $DOMAIN)

if [ -z "$RESOLVED_IP" ]; then
    echo "❌ DNS not configured yet!"
    echo ""
    echo "📋 Please add this DNS record to hariom.site:"
    echo "Type: A"
    echo "Name: download"
    echo "Value: $PUBLIC_IP"
    echo "TTL: 300"
    echo ""
    echo "After adding the DNS record, wait 5-10 minutes and run this script again."
    exit 1
elif [ "$RESOLVED_IP" != "$PUBLIC_IP" ]; then
    echo "⚠️ DNS points to $RESOLVED_IP but server is at $PUBLIC_IP"
    echo "Please update your DNS record or wait for propagation."
    exit 1
else
    echo "✅ DNS correctly configured!"
fi

# Check if port 8081 is open
echo ""
echo "🔒 Checking firewall..."
if command -v ufw &> /dev/null; then
    if sudo ufw status | grep -q "8081"; then
        echo "✅ Port 8081 is open in UFW"
    else
        echo "🔧 Opening port 8081..."
        sudo ufw allow 8081
        echo "✅ Port 8081 opened"
    fi
fi

# Test the connection
echo ""
echo "🧪 Testing connection..."
if curl -s --connect-timeout 5 "http://$DOMAIN:8081/bot8294062867:AAHShbknrcrBB4bsJsQdMpwQoxq7Ms6jcMM/getMe" | grep -q '"ok":true'; then
    echo "✅ Domain connection working!"
else
    echo "⚠️ Connection test failed. This might be normal if the container isn't fully ready."
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "📋 Your download links will now look like:"
echo "http://download.hariom.site:8081/file/bot.../documents/file.mkv"
echo ""
echo "🔧 Next steps:"
echo "1. Restart your bot: pm2 restart direct-link-bot"
echo "2. Upload a file and test /link command"
echo "3. Optional: Set up SSL certificate for HTTPS"