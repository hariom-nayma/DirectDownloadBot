const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
require('dotenv').config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use('/file/', limiter);

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// MongoDB connection
mongoose.connect(process.env.DATABASE_URL || 'mongodb://localhost:27017/filetolink', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

// File schema
const FileSchema = new mongoose.Schema({
    fileId: { type: String, required: true, unique: true },
    telegramFileId: { type: String, required: true },
    fileName: { type: String, required: true },
    fileSize: { type: Number, required: true },
    mimeType: { type: String },
    messageId: { type: Number, required: true },
    channelId: { type: String, required: true },
    uploadedBy: { type: Number, required: true },
    uploadedAt: { type: Date, default: Date.now },
    downloads: { type: Number, default: 0 },
    lastAccessed: { type: Date, default: Date.now }
});

const File = mongoose.model('File', FileSchema);

// User schema for analytics
const UserSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    username: { type: String },
    firstName: { type: String },
    joinedAt: { type: Date, default: Date.now },
    filesUploaded: { type: Number, default: 0 },
    lastActive: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// Configuration
const BIN_CHANNEL = process.env.BIN_CHANNEL; // Your storage channel ID
const DOMAIN = process.env.DOMAIN || 'http://localhost:3000';
const ADMIN_ID = process.env.ADMIN_ID;

// Helper functions
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function saveUser(userInfo) {
    try {
        await User.findOneAndUpdate(
            { userId: userInfo.id },
            {
                username: userInfo.username,
                firstName: userInfo.first_name,
                lastActive: new Date()
            },
            { upsert: true, new: true }
        );
    } catch (error) {
        console.error('Error saving user:', error);
    }
}

// Bot commands
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await saveUser(msg.from);
    
    const welcomeText = `
🌟 **Welcome to FileToLink Bot!** 🌟

I convert your files into permanent direct download links!

✨ **Features:**
📎 Upload any file and get a permanent link
🔗 Links never expire or break
⚡ Fast streaming and downloads
🌐 Works from any browser or download manager

📋 **How to use:**
1. Send me any file (document, video, audio, etc.)
2. I'll give you a permanent download link
3. Share the link with anyone!

🔧 **Commands:**
/help - Show this help message
/stats - View your upload statistics
/about - About this bot

Ready to get started? Send me a file! 📁
    `;
    
    bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
    const helpText = `
📋 **FileToLink Bot Help**

**Basic Usage:**
• Send any file to get a permanent download link
• Links work forever and never break
• No file size limits (within Telegram's limits)

**Commands:**
• /start - Welcome message
• /help - This help message  
• /stats - Your upload statistics
• /about - About this bot

**Supported Files:**
• Documents (PDF, DOC, etc.)
• Videos (MP4, MKV, etc.)
• Audio (MP3, FLAC, etc.)
• Images (JPG, PNG, etc.)
• Archives (ZIP, RAR, etc.)

**Features:**
• ✅ Permanent links
• ✅ Fast streaming
• ✅ No expiration
• ✅ Browser compatible
• ✅ Download manager support

Just send me a file and I'll do the rest! 🚀
    `;
    
    bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        const user = await User.findOne({ userId });
        const userFiles = await File.find({ uploadedBy: userId });
        const totalDownloads = userFiles.reduce((sum, file) => sum + file.downloads, 0);
        
        const statsText = `
📊 **Your Statistics**

👤 **User:** ${msg.from.first_name}
📅 **Joined:** ${user ? user.joinedAt.toDateString() : 'Unknown'}
📁 **Files Uploaded:** ${userFiles.length}
⬇️ **Total Downloads:** ${totalDownloads}
🕒 **Last Active:** ${user ? user.lastActive.toDateString() : 'Now'}

Keep sharing files! 🚀
        `;
        
        bot.sendMessage(chatId, statsText, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '❌ Error fetching statistics. Please try again.');
    }
});

bot.onText(/\/about/, (msg) => {
    const aboutText = `
ℹ️ **About FileToLink Bot**

🤖 **Version:** 1.0.0
⚡ **Built with:** Node.js + Express
🗄️ **Database:** MongoDB
🌐 **Domain:** ${DOMAIN}

**Features:**
• Permanent file links
• High-speed streaming
• No file expiration
• Professional URLs
• Built-in analytics

**Developer:** @hariom_nayma
**Source:** Open Source
**License:** MIT

Made with ❤️ for the community!
    `;
    
    bot.sendMessage(msg.chat.id, aboutText, { parse_mode: 'Markdown' });
});

// Handle file uploads
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    
    // Skip if it's a command or text message
    if (msg.text && msg.text.startsWith('/')) return;
    if (!msg.document && !msg.video && !msg.audio && !msg.photo && !msg.voice && !msg.sticker) return;
    
    await saveUser(msg.from);
    
    let fileInfo = {};
    
    // Extract file information based on type
    if (msg.document) {
        fileInfo = {
            telegramFileId: msg.document.file_id,
            fileName: msg.document.file_name || 'document',
            fileSize: msg.document.file_size,
            mimeType: msg.document.mime_type
        };
    } else if (msg.video) {
        fileInfo = {
            telegramFileId: msg.video.file_id,
            fileName: msg.video.file_name || 'video.mp4',
            fileSize: msg.video.file_size,
            mimeType: msg.video.mime_type || 'video/mp4'
        };
    } else if (msg.audio) {
        fileInfo = {
            telegramFileId: msg.audio.file_id,
            fileName: msg.audio.file_name || `${msg.audio.title || 'audio'}.mp3`,
            fileSize: msg.audio.file_size,
            mimeType: msg.audio.mime_type || 'audio/mpeg'
        };
    } else if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
        fileInfo = {
            telegramFileId: photo.file_id,
            fileName: 'photo.jpg',
            fileSize: photo.file_size,
            mimeType: 'image/jpeg'
        };
    } else if (msg.voice) {
        fileInfo = {
            telegramFileId: msg.voice.file_id,
            fileName: 'voice.ogg',
            fileSize: msg.voice.file_size,
            mimeType: msg.voice.mime_type || 'audio/ogg'
        };
    } else if (msg.sticker) {
        fileInfo = {
            telegramFileId: msg.sticker.file_id,
            fileName: 'sticker.webp',
            fileSize: msg.sticker.file_size,
            mimeType: 'image/webp'
        };
    }
    
    if (!fileInfo.telegramFileId) return;
    
    const processingMsg = await bot.sendMessage(chatId, '⏳ Processing your file...');
    
    try {
        // Forward file to storage channel
        const forwardedMsg = await bot.forwardMessage(BIN_CHANNEL, chatId, msg.message_id);
        
        // Generate unique file ID
        const uniqueFileId = uuidv4();
        
        // Save to database
        const fileDoc = new File({
            fileId: uniqueFileId,
            telegramFileId: fileInfo.telegramFileId,
            fileName: fileInfo.fileName,
            fileSize: fileInfo.fileSize || 0,
            mimeType: fileInfo.mimeType,
            messageId: forwardedMsg.message_id,
            channelId: BIN_CHANNEL,
            uploadedBy: msg.from.id
        });
        
        await fileDoc.save();
        
        // Update user stats
        await User.findOneAndUpdate(
            { userId: msg.from.id },
            { $inc: { filesUploaded: 1 } }
        );
        
        // Generate permanent link
        const downloadLink = `${DOMAIN}/file/${uniqueFileId}`;
        const streamLink = `${DOMAIN}/stream/${uniqueFileId}`;
        
        const successText = `
✅ **File Processed Successfully!**

📁 **File:** ${fileInfo.fileName}
💾 **Size:** ${formatBytes(fileInfo.fileSize)}
🆔 **ID:** \`${uniqueFileId}\`

🔗 **Permanent Links:**
📥 **Download:** ${downloadLink}
🎬 **Stream:** ${streamLink}

✨ **Features:**
• Links never expire
• Works in any browser
• Download manager compatible
• High-speed streaming

Share these links with anyone! 🚀
        `;
        
        await bot.editMessageText(successText, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📥 Download', url: downloadLink },
                        { text: '🎬 Stream', url: streamLink }
                    ],
                    [
                        { text: '📋 Copy Download Link', callback_data: `copy_${uniqueFileId}` }
                    ]
                ]
            }
        });
        
    } catch (error) {
        console.error('Error processing file:', error);
        await bot.editMessageText('❌ Error processing file. Please try again.', {
            chat_id: chatId,
            message_id: processingMsg.message_id
        });
    }
});

// Express routes for file serving
app.get('/file/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        
        // Find file in database
        const file = await File.findOne({ fileId });
        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        // Update download count and last accessed
        await File.findByIdAndUpdate(file._id, {
            $inc: { downloads: 1 },
            lastAccessed: new Date()
        });
        
        // Get file from Telegram
        const fileLink = await bot.getFileLink(file.telegramFileId);
        
        // Stream file from Telegram
        const response = await axios({
            method: 'GET',
            url: fileLink,
            responseType: 'stream',
            headers: req.headers.range ? { Range: req.headers.range } : {}
        });
        
        // Set appropriate headers
        res.set({
            'Content-Type': file.mimeType || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${file.fileName}"`,
            'Content-Length': response.headers['content-length'],
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=31536000'
        });
        
        // Handle range requests for video streaming
        if (response.status === 206) {
            res.status(206);
            res.set('Content-Range', response.headers['content-range']);
        }
        
        // Pipe the file stream
        response.data.pipe(res);
        
    } catch (error) {
        console.error('Error serving file:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/stream/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        
        // Find file in database
        const file = await File.findOne({ fileId });
        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        // Update access count
        await File.findByIdAndUpdate(file._id, {
            lastAccessed: new Date()
        });
        
        // Get file from Telegram
        const fileLink = await bot.getFileLink(file.telegramFileId);
        
        // Stream file from Telegram
        const response = await axios({
            method: 'GET',
            url: fileLink,
            responseType: 'stream',
            headers: req.headers.range ? { Range: req.headers.range } : {}
        });
        
        // Set streaming headers
        res.set({
            'Content-Type': file.mimeType || 'application/octet-stream',
            'Content-Length': response.headers['content-length'],
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=31536000'
        });
        
        // Handle range requests for video streaming
        if (response.status === 206) {
            res.status(206);
            res.set('Content-Range', response.headers['content-range']);
        }
        
        // Pipe the file stream
        response.data.pipe(res);
        
    } catch (error) {
        console.error('Error streaming file:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API endpoints
app.get('/api/stats', async (req, res) => {
    try {
        const totalFiles = await File.countDocuments();
        const totalUsers = await User.countDocuments();
        const totalDownloads = await File.aggregate([
            { $group: { _id: null, total: { $sum: '$downloads' } } }
        ]);
        
        res.json({
            totalFiles,
            totalUsers,
            totalDownloads: totalDownloads[0]?.total || 0,
            uptime: process.uptime()
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 FileToLink server running on port ${PORT}`);
    console.log(`🌐 Domain: ${DOMAIN}`);
    console.log(`📱 Bot: @${bot.options.username || 'Unknown'}`);
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

console.log('🤖 FileToLink Bot started successfully!');