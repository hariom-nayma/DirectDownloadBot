#!/bin/bash

DOMAIN="download.hariom.site"

echo "🔒 Setting up SSL Certificate for $DOMAIN..."

# Install certbot if not present
if ! command -v certbot &> /dev/null; then
    echo "📦 Installing Certbot..."
    sudo apt update
    sudo apt install -y certbot nginx
fi

# Install nginx if not present
if ! command -v nginx &> /dev/null; then
    echo "📦 Installing Nginx..."
    sudo apt install -y nginx
fi

# Create nginx configuration for HTTP (before SSL)
echo "📝 Creating Nginx configuration..."
sudo tee /etc/nginx/sites-available/telegram-downloads > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    
    # Let's Encrypt challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    
    # Proxy file downloads only
    location /file/ {
        proxy_pass http://localhost:8081;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # Security headers
        add_header X-Content-Type-Options nosniff;
        add_header X-Frame-Options DENY;
        add_header X-XSS-Protection "1; mode=block";
        
        # CORS headers for downloads
        add_header Access-Control-Allow-Origin "*";
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS";
        
        # Cache headers for better performance
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
    
    # Block API access for security
    location /bot {
        return 403;
    }
    
    # Default location
    location / {
        return 404;
    }
}
EOF

# Enable the site
sudo ln -sf /etc/nginx/sites-available/telegram-downloads /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Get SSL certificate
echo "🔐 Obtaining SSL certificate..."
sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@hariom.site

# Update bot configuration for HTTPS
echo "📝 Updating bot configuration for HTTPS..."
sed -i "s|http://download.hariom.site:8081|https://download.hariom.site|g" .env

echo ""
echo "🎉 SSL Setup Complete!"
echo ""
echo "✅ Your download links will now be:"
echo "https://download.hariom.site/file/bot.../documents/file.mkv"
echo ""
echo "🔒 Benefits:"
echo "• Secure HTTPS connections"
echo "• Professional appearance"
echo "• Better browser compatibility"
echo "• API endpoints blocked for security"
echo ""
echo "🔧 Restart your bot: pm2 restart direct-link-bot"