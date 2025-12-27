const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Replace 'YOUR_TELEGRAM_BOT_TOKEN' with your actual bot token
// You can also set it via environment variable: process.env.BOT_TOKEN
const token = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';

// Support local Telegram Bot API server for >50MB uploads
const baseApiUrl = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';

console.log(`Initializing bot with API URL: ${baseApiUrl}`);

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, {
    polling: true,
    baseApiUrl: baseApiUrl
});

const fluentFfmpeg = require('fluent-ffmpeg');
const progress = require('progress-stream');

// --- Helper Functions ---

// Simple in-memory store for settings (use a DB for production)
const userSettings = {};

function getSettings(chatId) {
    if (!userSettings[chatId]) {
        userSettings[chatId] = { max_size_gb: 2, screenshots: true }; // Default ON for testing
    }
    return userSettings[chatId];
}



function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function generateProgressBar(percent) {
    const totalBars = 20;
    const filledBars = Math.round((percent / 100) * totalBars);
    const emptyBars = totalBars - filledBars;
    return '█'.repeat(filledBars) + '░'.repeat(emptyBars);
}

// Ensure the 'downloads' directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

bot.on('polling_error', (error) => {
    console.error(`[polling_error] ${error.code}: ${error.message}`);
});

// --- Commands ---

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Welcome! Send me a link to download.\nUse /settings to configure options.");
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, "Send a direct URL to download.\n/settings - Configure upload limit & screenshots.");
});

bot.onText(/\/settings/, (msg) => {
    const chatId = msg.chat.id;
    const settings = getSettings(chatId);

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: `Upload Limit: ${settings.max_size_gb}GB`, callback_data: 'toggle_limit' },
                    { text: `Screenshots: ${settings.screenshots ? 'ON' : 'OFF'}`, callback_data: 'toggle_screenshots' }
                ]
            ]
        }
    };
    bot.sendMessage(chatId, "Current Settings:", opts);
});

bot.on('callback_query', (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;
    const settings = getSettings(chatId);

    if (data === 'toggle_limit') {
        settings.max_size_gb = settings.max_size_gb === 2 ? 4 : 2;
    } else if (data === 'toggle_screenshots') {
        settings.screenshots = !settings.screenshots;
    }

    const opts = {
        chat_id: chatId,
        message_id: msg.message_id,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: `Upload Limit: ${settings.max_size_gb}GB`, callback_data: 'toggle_limit' },
                    { text: `Screenshots: ${settings.screenshots ? 'ON' : 'OFF'}`, callback_data: 'toggle_screenshots' }
                ]
            ]
        }
    };
    bot.editMessageText("Current Settings (Updated):", opts);
    bot.answerCallbackQuery(callbackQuery.id);
});

// --- main Logic ---

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return;

    // Relaxed URL validation
    let targetUrl;
    try {
        targetUrl = new URL(text);
        if (!targetUrl.protocol.startsWith('http')) throw new Error('Invalid protocol');
    } catch (e) {
        bot.sendMessage(chatId, "Please send a valid HTTP/HTTPS URL.");
        return;
    }

const https = require('https');

// ...

    const settings = getSettings(chatId);
    let statusMsg = await bot.sendMessage(chatId, "Initializing download...");
    let statusMsgId = statusMsg.message_id;
    let lastUpdate = Date.now();

    try {
        const agent = new https.Agent({  
            rejectUnauthorized: false, // Bypasses SSL errors (use with caution)
            keepAlive: true 
        });

        // Download with progress
        const response = await axios({
            url: text,
            method: 'GET',
            responseType: 'stream',
            timeout: 120000, // Increased to 120s
            httpsAgent: agent,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                'Referer': targetUrl.origin,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive'
            }
        });

        // Try to get filename from Content-Disposition
        let fileName = 'downloaded_file';
        const contentDisposition = response.headers['content-disposition'];
        if (contentDisposition) {
            const match = contentDisposition.match(/filename="?([^"]+)"?/);
            if (match && match[1]) {
                fileName = match[1];
            }
        } else {
             // Fallback to URL path
             try {
                const pathname = targetUrl.pathname;
                const basename = path.basename(pathname);
                if (basename && basename.length > 0) fileName = basename;
                // Decode URI component just in case
                fileName = decodeURIComponent(fileName);
            } catch (e) {}
        }
        
        // Sanitize filename
        fileName = fileName.replace(/[<>:"/\\|?*]+/g, '_');

        const filePath = path.join(downloadsDir, fileName);
        const writer = fs.createWriteStream(filePath);

        const totalLength = response.headers['content-length'];
        let downloadedLength = 0;
        let startTime = Date.now();

        response.data.on('data', (chunk) => {
            downloadedLength += chunk.length;
            const now = Date.now();
            if (now - lastUpdate > 2000 && totalLength) { // Update every 2s
                const percent = ((downloadedLength / totalLength) * 100).toFixed(1);
                const speed = (downloadedLength / ((now - startTime) / 1000)); // bytes per sec
                const speedStr = formatBytes(speed) + '/s';
                const progressStr = generateProgressBar(percent);

                bot.editMessageText(`⬇️ Downloading...\n${progressStr} ${percent}%\nSpeed: ${speedStr}\nSize: ${formatBytes(downloadedLength)} / ${formatBytes(totalLength)}`, {
                    chat_id: chatId,
                    message_id: statusMsgId
                }).catch(e => { }); // Ignore edit errors
                lastUpdate = now;
            }
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Verify size limit (Logical check)
        const stats = fs.statSync(filePath);
        if (stats.size > settings.max_size_gb * 1024 * 1024 * 1024) {
            throw new Error(`File size (${formatBytes(stats.size)}) exceeds your limit of ${settings.max_size_gb}GB.`);
        }

        // --- Screenshots logic ---
        let screenshots = [];
        console.log(`[Debug] Checking screenshots. Enabled: ${settings.screenshots}, Filename: ${fileName}`);

        if (settings.screenshots) {
             if (fileName.match(/\.(mp4|mkv|avi|mov)$/i)) {
                 console.log("[Debug] File is video. Starting ffprobe...");
                 bot.editMessageText("Processing screenshots...", { chat_id: chatId, message_id: statusMsgId }).catch(e=>{});

                 await new Promise((resolve) => {
                     fluentFfmpeg.ffprobe(filePath, (err, metadata) => {
                         if (err) { console.error("[Debug] ffprobe error:", err); resolve(); return; }
                         if (!metadata) { console.error("[Debug] No metadata"); resolve(); return; }
                         
                         const duration = metadata.format.duration;
                         console.log(`[Debug] Video Duration: ${duration}`);
                         
                         if (duration > 0) { // > 0 secs (Testing Mode)
                             const count = 10;
                             console.log("[Debug] Taking screenshots...");
                             // Take screenshots
                             fluentFfmpeg(filePath)
                               .on('end', () => { console.log("[Debug] Screenshots taken."); resolve(); })
                               .on('error', (e) => { console.error('[Debug] Screenshot error', e); resolve(); })
                               .screenshots({
                                   count: count,
                                   folder: downloadsDir,
                                   filename: 'thumb-%r.png',
                                   size: '320x240'
                               });
                         } else {
                             console.log("[Debug] Duration too short");
                             resolve(); // too short
                         }
                     });
                 });
                 
                 // Collect generated screenshots
                  const files = fs.readdirSync(downloadsDir).filter(f => f.startsWith('thumb-'));
                  console.log(`[Debug] Found ${files.length} screenshots.`);
                  screenshots = files.map(f => path.join(downloadsDir, f));
             } else {
                  console.log("[Debug] File is NOT video (regex mismatch)");
             }
        }

        bot.editMessageText("⬆️ Uploading...", { chat_id: chatId, message_id: statusMsgId }).catch(e => { });

        // Upload Tracking
        const fileStat = fs.statSync(filePath);
        const str = progress({
            length: fileStat.size,
            time: 1000 /* ms */
        });

        str.on('progress', (progress) => {
            const now = Date.now();
            if (now - lastUpdate > 3000) {
                const percent = progress.percentage.toFixed(1);
                const speedStr = formatBytes(progress.speed) + '/s';
                const progressStr = generateProgressBar(percent);

                bot.editMessageText(`⬆️ Uploading...\n${progressStr} ${percent}%\nSpeed: ${speedStr}`, {
                    chat_id: chatId,
                    message_id: statusMsgId
                }).catch(e => { });
                lastUpdate = now;
            }
        });

        // We have to stream specifically to pipe through 'progress-stream'
        // node-telegram-bot-api accepts a stream
        const fileStream = fs.createReadStream(filePath).pipe(str);

        // Send Video if likely video, else Document
        if (fileName.match(/\.(mp4|mkv|avi|mov)$/i)) {
            await bot.sendVideo(chatId, fileStream, {}, { filename: fileName });
        } else {
            await bot.sendDocument(chatId, fileStream, {}, { filename: fileName });
        }

        // Send screenshots if any
        if (screenshots.length > 0) {
            // Send as album
            const mediaGroup = screenshots.map(p => ({
                type: 'photo',
                media: p
            }));
            // Media groups max 10
            if (mediaGroup.length > 0) {
                await bot.sendMediaGroup(chatId, mediaGroup.slice(0, 10));
            }
            // Cleanup screenshots
            screenshots.forEach(p => fs.unlinkSync(p));
        }

        // Cleanup main file
        fs.unlinkSync(filePath);
        bot.deleteMessage(chatId, statusMsgId).catch(e => { }); // Clean up status message

    } catch (error) {
        console.error("Error processing link:", error.message);
        let errorMessage = error.message;
        if (error.code === 'ETIMEDOUT') errorMessage = "Connection timed out.";
        bot.sendMessage(chatId, `Failed: ${errorMessage}`);
        // Cleanup if needed
        if (fs.existsSync(downloadsDir)) {
            // Cleanup logic if valuable
        }
    }
});

console.log("Bot is running...");
