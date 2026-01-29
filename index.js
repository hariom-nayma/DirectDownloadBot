const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { exec } = require('child_process');

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
const https = require('https');
const { File, Storage } = require('megajs');

const { getUser, updateUser, checkPlan, getSettings, updateSettings, getGoogleToken, saveGoogleToken } = require('./helpers');
const { bypassUrl } = require('./bypass');
const { google } = require('googleapis');

// Google OAuth Setup
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
);

// Admin ID from env
const ADMIN_ID = process.env.ADMIN_ID;

// Separate logs for Setup State vs Running Jobs
const setupState = {}; // { chatId: { state: 'WAITING_RENAME'|'WAITING_THUMB', pendingUrl, customName, customThumb } }
const runningJobs = {}; // { jobId: { chatId, controller, stream, filePath } }
const userDownloads = {}; // { chatId: [jobId1, jobId2] }

// Helper to get effective limits based on plan
// Helper to get effective limits based on plan
function getPlanLimits(plan) {
    if (plan === 'free') return { max_gb: 1, parallel: 1, daily_limit_gb: 5 };
    if (plan === 'basic') return { max_gb: 1, parallel: 1, daily_limit_gb: 15 };
    if (plan === 'premium') return { max_gb: 2, parallel: 2, daily_limit_gb: 30 };
    if (plan === 'vip') return { max_gb: 2, parallel: 3, daily_limit_gb: 50 };
    return { max_gb: 1, parallel: 1, daily_limit_gb: 5 };
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(seconds) {
    if (!seconds) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.round(seconds % 60);
    const mStr = m > 9 ? m : '0' + m;
    const sStr = s > 9 ? s : '0' + s;
    if (h > 0) return `${h}:${mStr}:${sStr}`;
    return `${mStr}:${sStr}`;
}

function generateProgressBar(percent) {
    const totalBars = 20;
    const filledBars = Math.round((percent / 100) * totalBars);
    const emptyBars = totalBars - filledBars;
    return '█'.repeat(filledBars) + '░'.repeat(emptyBars);
}

function generateCaption(template, metadata) {
    // Default Template if null
    if (!template) {
        template = "Title : {filename}\nSize : {filesize}\nDuration : {duration} ( if its a video )\n\nMade with ❤️ by @sadsoul_main";
    }

    let caption = template;
    caption = caption.replace(/{filename}/g, metadata.filename || 'Unknown');
    caption = caption.replace(/{filesize}/g, metadata.filesize || 'Unknown');
    caption = caption.replace(/{duration}/g, metadata.duration || 'N/A');
    caption = caption.replace(/{extension}/g, metadata.extension || '');
    caption = caption.replace(/{mimetype}/g, metadata.mimetype || '');

    return caption.trim();
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
    const text = `
🌟 *Welcome to DirectLink Bot!* 🌟

I am your High-Speed Downloader. 🚀
Send me any direct download link, and I'll fetch it for you instantly!

✨ *Features:*
🎥 Video Detection & Screenshots
💾 Large File Support (Up to 2GB)
⚡ Ultra-Fast Parallel Processing
☁️ Auto-Sync to Telegram Cloud

🔹 *Free Plan:* 3 Downloads/Week, 1GB Max
💎 *Premium:* Unlimited Downloads, Rename, Custom Thumb, Custom Caption, 2GB Max

👇 *Type /plan to upgrade!*
    `;
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/myid/, (msg) => {
    bot.sendMessage(msg.chat.id, `Your ID: \`${msg.from.id}\``, { parse_mode: 'Markdown' });
});

// Plan Command: Show Plan Info and Buy Buttons (No Settings)
bot.onText(/\/plan/, (msg) => {
    const chatId = msg.chat.id;
    const user = checkPlan(chatId);

    let expiryText = "Lifetime";
    if (user.expiry) {
        expiryText = new Date(user.expiry).toLocaleDateString();
    }

    const usageText = user.plan === 'free' ? `\nWeekly Usage: ${user.downloads_this_week}/3` : `${user.downloads_this_week}`;

    const text =
        `💎 *Your Current Plan*
━━━━━━━━━━━━━━━
📌 *Plan:* ${user.plan.toUpperCase()}
⏳ *Expiry:* ${expiryText}
📊 ${usageText}

✨ *Upgrade Options*
━━━━━━━━━━━━━━━
🆓 *Free* — ₹0 / month  
✅ 3 Downloads/Week, 1GB Max
📦 Up to *1 GB* per file  
🌟 Daily Upload Limit: *5 GB*
⚡ *1* parallel download  


🥉 *Basic* — ₹79 / month  
✅ Unlimited downloads  
📦 Up to *1 GB* per file  
🌟 Daily Upload Limit: *15 GB*
⚡ *1* parallel download  

🥈 *Premium* — ₹99 / month  
✅ Unlimited downloads  
📦 Up to *2 GB* per file  
⚡ *2* parallel downloads  
🌟 Daily Upload Limit: *30 GB*
📝 Custom captions  

🥇 *VIP* — ₹199 / *3 months*  
✅ Unlimited downloads  
📦 Up to *2 GB* per file  
⚡ *3* parallel downloads  
🌟 Daily Upload Limit: *50 GB*
📝 Custom captions  
🔥 *3 months access*

💬 To upgrade, use: /buy <plan>
Example: \`/buy premium\`
`;

    const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Buy Basic (₹79)", url: "https://t.me/clickme4it?text=I%20want%20to%20buy%20Basic%20Plan" },
                    { text: "Buy Premium (₹99)", url: "https://t.me/clickme4it?text=I%20want%20to%20buy%20Premium%20Plan" }
                ],
                [
                    { text: "Buy VIP (₹199)", url: "https://t.me/clickme4it?text=I%20want%20to%20buy%20VIP%20Plan" }
                ]
            ]
        }
    };
    bot.sendMessage(chatId, text, opts);
});

// Settings Command: Configurations
bot.onText(/\/settings/, (msg) => {
    const chatId = msg.chat.id;
    const user = checkPlan(chatId);

    bot.sendMessage(chatId, "⚙️ *Bot Settings*", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: `Screenshots: ${user.screenshots !== false ? 'ON' : 'OFF'}`, callback_data: 'toggle_screenshots' }]
            ]
        }
    });
});

bot.onText(/\/set_caption(.+)?/, (msg, match) => {
    const chatId = msg.chat.id;
    const user = checkPlan(chatId);

    if (user.plan === 'free' || user.plan === 'basic') {
        bot.sendMessage(chatId, "🔒 *Premium Feature*\n\nUpgrade to Premium or VIP to set custom captions!\n/plan", { parse_mode: 'Markdown' });
        return;
    }

    const input = match[1] ? match[1].trim() : null;

    if (!input) {
        let current = user.custom_caption || "Default";
        // Escape backticks for display
        current = current.replace(/`/g, '\\`');

        bot.sendMessage(chatId, `📝 *Custom Caption Settings*\n\n*Current Template:*\n\`${current}\`\n\n*Variables:*\n{filename}, {filesize}, {duration}, {extension}\n\n*To set:* \`/set_caption My File: {filename}...\`\n*To reset:* \`/set_caption reset\``, { parse_mode: 'Markdown' });
        return;
    }

    if (input.toLowerCase() === 'reset') {
        updateUser(chatId, { custom_caption: null });
        bot.sendMessage(chatId, "✅ Caption reset to default.");
        return;
    }

    updateUser(chatId, { custom_caption: input });
    bot.sendMessage(chatId, "✅ Custom caption set!");
});


// Admin Commands
bot.onText(/\/up_(basic|premium|vip) (.+)/, (msg, match) => {
    if (String(msg.from.id) !== String(ADMIN_ID)) return;

    const plan = match[1];
    const targetId = match[2].trim();

    let durationDays = 30;
    if (plan === 'vip') durationDays = 90; // 3 Months

    const expiry = Date.now() + (durationDays * 24 * 60 * 60 * 1000);

    updateUser(targetId, { plan: plan, expiry: expiry });
    bot.sendMessage(msg.chat.id, `✅ User ${targetId} upgraded to ${plan.toUpperCase()} until ${new Date(expiry).toLocaleDateString()}`);
    bot.sendMessage(targetId, `🎉 Your plan has been upgraded to *${plan.toUpperCase()}*!`, { parse_mode: 'Markdown' });
});

bot.onText(/\/setdump (.+)/, (msg, match) => {
    if (String(msg.from.id) !== String(ADMIN_ID)) return;

    // Normalize ID (channel IDs usually start with -100)
    let dumpId = match[1].trim();
    if (!dumpId.startsWith('-100') && !dumpId.startsWith('@')) {
        // rough heuristic, or just trust the admin inputs the correct ID
    }

    updateSettings({ dump_channel_id: dumpId });
    bot.sendMessage(msg.chat.id, `✅ Dump Channel configured to: \`${dumpId}\`\n\nMake sure the bot is an admin there!`, { parse_mode: 'Markdown' });
});

bot.onText(/\/setforce (.+)/, (msg, match) => {
    if (String(msg.from.id) !== String(ADMIN_ID)) return;

    let forceId = match[1].trim();
    // Basic cleanup
    if (forceId.toLowerCase() === 'off' || forceId.toLowerCase() === 'disable') {
        updateSettings({ force_channel_id: null });
        bot.sendMessage(msg.chat.id, "✅ Force Join disabled.");
        return;
    }

    updateSettings({ force_channel_id: forceId });
    bot.sendMessage(msg.chat.id, `✅ Force Join Channel configured to: \`${forceId}\`\n\nMake sure the bot is an admin there to check memberships!`, { parse_mode: 'Markdown' });
});

// Helper: Check Membership
async function isMember(userId) {
    const settings = getSettings();
    const forceId = settings.force_channel_id;
    if (!forceId) return true; // Not enabled

    try {
        const member = await bot.getChatMember(forceId, userId);
        if (['creator', 'administrator', 'member'].includes(member.status)) {
            return true;
        }
    } catch (e) {
        console.error("Force Join Check Error:", e.message);
        // If bot isn't admin or channel invalid, fail open or closed? 
        // Let's return true to avoid blocking everyone if misconfigured, but log error.
        // Or return false to enforce? User asked to "force join", so better to fail safe if we can't check?
        // Actually, if we can't check, we probably shouldn't block.
        return true;
    }
    return false;
}

// Helper: Send Force Join Message
async function sendForceJoinMessage(chatId) {
    const settings = getSettings();
    const forceId = settings.force_channel_id;
    let inviteLink = forceId; // Default to ID if no link known

    // Try to make it a link if it's a username
    if (forceId.startsWith('@')) {
        inviteLink = `https://t.me/${forceId.substring(1)}`;
    } else {
        // If ID, we can't easily guess link unless we export invite link, 
        // but for now let's assume admin provides a public channel username or we just use the ID text (which isn't clickable).
        // Best practice: Admin should set @username if possible.
        // For private channels, this is harder without generating link. 
        // Let's assume public username for now as per "add a group/channel".
    }

    bot.sendMessage(chatId, "⚠️ *Join Required*\n\nYou must join our channel to use this bot!", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "Join Channel 🚀", url: inviteLink }],
                [{ text: "Try Again 🔄", callback_data: "check_join" }]
            ]
        }
    });
}

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;
    // const user = checkPlan(chatId); 

    if (data === 'check_join') {
        const allowed = await isMember(callbackQuery.from.id);
        if (allowed) {
            bot.deleteMessage(chatId, msg.message_id).catch(e => { });
            bot.sendMessage(chatId, "✅ Verified! You can now use the bot.");
        } else {
            bot.answerCallbackQuery(callbackQuery.id, { text: "❌ You haven't joined yet!", show_alert: true });
        }
        return;
    }

    if (data === 'resume_mega') {
        const user = checkPlan(chatId);
        if (user.last_mega_job && user.last_mega_job.url) {
            // Unpause
            if (pausedJobs[chatId]) delete pausedJobs[chatId];

            bot.deleteMessage(chatId, msg.message_id).catch(e => { });
            bot.sendMessage(chatId, `🔄 Resuming download from file #${user.last_mega_job.processed_count + 1}...`);
            processMegaFolder(chatId, user.last_mega_job.url, user.last_mega_job.processed_count);
        } else {
            bot.answerCallbackQuery(callbackQuery.id, { text: "❌ No resumable job found.", show_alert: true });
        }
        return;
    }

    if (data === 'pause_mega') {
        // Set Pause State
        pausedJobs[chatId] = { command: 'PAUSE' };

        // Find and Kill Active Stream to trigger loop break
        // We need to find the job for this chat
        const jobIds = userDownloads[chatId] || [];
        // Just kill all running jobs for this chat (usually just one for Mega)
        let found = false;
        jobIds.forEach(jid => {
            if (runningJobs[jid]) {
                found = true;
                const { stream } = runningJobs[jid];
                // Destroy stream to trigger error/close in processMegaFolder
                if (stream) stream.destroy();
            }
        });

        if (!found) {
            bot.answerCallbackQuery(callbackQuery.id, { text: "⚠️ No active job found to pause.", show_alert: true });
        } else {
            bot.answerCallbackQuery(callbackQuery.id, { text: "⏸️ Pausing..." });
        }
        return;
    }

    const user = checkPlan(chatId);

    if (data === 'toggle_screenshots') {
        const newState = user.screenshots === false ? true : false; // Default true
        updateUser(chatId, { screenshots: newState });
        bot.answerCallbackQuery(callbackQuery.id, { text: `Screenshots ${newState ? 'ON' : 'OFF'}` });

    } else if (data === 'start_rename') {
        if (!setupState[chatId]) setupState[chatId] = {};
        setupState[chatId].state = 'WAITING_RENAME';
        bot.editMessageText("✏️ *Send me the new filename:*", {
            chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown'
        });

    } else if (data === 'start_thumb') {
        if (!setupState[chatId]) setupState[chatId] = {};
        setupState[chatId].state = 'WAITING_THUMB';
        bot.editMessageText("🖼️ *Send me a photo to use as cover:*", {
            chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown'
        });

    } else if (data === 'confirm_download') {
        const job = setupState[chatId];
        if (job && job.pendingUrl) {
            bot.deleteMessage(chatId, msg.message_id).catch(e => { });
            // Start download with captured options
            processDownload(chatId, job.pendingUrl, job.customName, job.customThumb);
            // Clear setup state
            delete setupState[chatId];
        }

    } else if (data.startsWith('cancel_')) {
        const jobId = data.replace('cancel_', '');

        // Setup Cancellation (cancel_process)
        if (jobId === 'process') {
            delete setupState[chatId];
            bot.editMessageText("❌ Setup Cancelled.", {
                chat_id: chatId,
                message_id: msg.message_id
            }).catch(e => { });
            return;
        }

        // Job Cancellation
        const job = runningJobs[jobId];
        if (job) {
            if (job.controller) job.controller.abort();
            if (job.stream) {
                try { job.stream.destroy(); } catch (e) { }
            }
            if (job.filePath && fs.existsSync(job.filePath)) {
                try { fs.unlinkSync(job.filePath); } catch (e) { };
            }

            bot.answerCallbackQuery(callbackQuery.id, { text: "Cancelling download..." });
            // Cleanup happens in finally block of processDownload
        } else {
            bot.answerCallbackQuery(callbackQuery.id, { text: "Job already finished or invalid." });
        }
    }

    bot.answerCallbackQuery(callbackQuery.id);
});

// --- Mega.nz Logic ---

bot.onText(/\/login_mega (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const email = match[1].trim();
    const password = match[2].trim();

    bot.sendMessage(chatId, "🔐 Verifying credentials...");

    try {
        const storage = new Storage({ email, password });
        await new Promise((resolve, reject) => {
            storage.on('ready', resolve);
            storage.on('error', reject);
        });

        updateUser(chatId, { mega_auth: { email, password } });
        bot.sendMessage(chatId, "✅ *Mega Login Successful!*\n\nThe bot will now auto-switch to your account limit if the free limit is reached.", { parse_mode: 'Markdown' });
    } catch (e) {
        bot.sendMessage(chatId, `❌ Login Failed: ${e.message}`);
    }
});

// --- Google Drive Logic ---

bot.onText(/\/gdrive$/, (msg) => {
    const chatId = msg.chat.id;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return bot.sendMessage(chatId, "❌ Google Drive Integration is not configured on this bot. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env");
    }

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/drive.file']
    });

    bot.sendMessage(chatId, `🔗 *Link Google Drive*\n\n1. [Click Here](${authUrl}) to authorize.\n2. Copy the code.\n3. Send the code using:\n\`/gauth <your-code>\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/gauth (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const code = match[1].trim();

    try {
        const { tokens } = await oauth2Client.getToken(code);
        saveGoogleToken(chatId, tokens);
        bot.sendMessage(chatId, "✅ *Google Drive Connected!*", { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, `❌ Auth Error: ${error.message}`);
    }
});

bot.onText(/\/gdrive_add/, async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.reply_to_message) {
        return bot.sendMessage(chatId, "⚠️ Reply to a file with /gdrive_add to upload it.");
    }

    const tokens = getGoogleToken(chatId);
    if (!tokens) {
        return bot.sendMessage(chatId, "⚠️ You are not connected to Google Drive. Use /gdrive to connect.");
    }

    oauth2Client.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Identify file
    const reply = msg.reply_to_message;
    let fileId;
    let fileName = 'telegram_upload';

    if (reply.document) { fileId = reply.document.file_id; fileName = reply.document.file_name; }
    else if (reply.video) { fileId = reply.video.file_id; fileName = reply.video.file_name || 'video.mp4'; }
    else if (reply.audio) { fileId = reply.audio.file_id; fileName = reply.audio.file_name || 'audio.mp3'; }
    else if (reply.photo && reply.photo.length > 0) {
        fileId = reply.photo[reply.photo.length - 1].file_id;
        fileName = 'photo.jpg';
    }

    if (!fileId) return bot.sendMessage(chatId, "❌ No file found.");

    let lastUpdateListener = 0;
    let statusMsg = await bot.sendMessage(chatId, "⏳ *Downloading from Telegram...*", { parse_mode: 'Markdown' });
    let filePath = null;

    try {
        // 1. Get File Info
        const file = await bot.getFile(fileId);
        const fileLink = file.file_path;
        filePath = path.join(downloadsDir, `${Date.now()}_${fileName}`);

        // Check if it's a URL or a Local Path (Local API returns absolute path starting with /)
        // Cloud API returns relative path (e.g. "videos/file_123.mp4")
        const isLocalPath = fileLink.startsWith('/') || (fileLink.match(/^[a-zA-Z]:/) !== null);

        if (!isLocalPath) {
            // --- URL Download (Cloud API) ---
            let downloadUrl;
            if (baseApiUrl.includes('http')) {
                downloadUrl = `${baseApiUrl}/file/bot${token}/${fileLink}`;
            } else {
                downloadUrl = `https://api.telegram.org/file/bot${token}/${fileLink}`;
            }

            const writer = fs.createWriteStream(filePath);
            const response = await axios({
                url: downloadUrl,
                method: 'GET',
                responseType: 'stream'
            });

            const totalLength = response.headers['content-length'];
            let downloadedLength = 0;

            response.data.on('data', (chunk) => {
                downloadedLength += chunk.length;
                const now = Date.now();
                if (now - lastUpdateListener > 2000) {
                    const percent = totalLength ? ((downloadedLength / totalLength) * 100).toFixed(1) : '0';
                    const mb = (downloadedLength / (1024 * 1024)).toFixed(2);
                    bot.editMessageText(`⬇️ *Downloading using HTTP...*\n\n${generateProgressBar(percent)} ${percent}%\n${mb} MB`, {
                        chat_id: chatId,
                        message_id: statusMsg.message_id,
                        parse_mode: 'Markdown'
                    }).catch(() => { });
                    lastUpdateListener = now;
                }
            });

            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

        } else {
            // --- Local Path Copy (Local API Volume Mapped) ---
            bot.editMessageText("⬇️ *Copying from Local Server...*", {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            });

            // Try Direct Copy
            let copySuccess = false;
            if (fs.existsSync(fileLink)) {
                try {
                    await new Promise((resolve, reject) => {
                        const r = fs.createReadStream(fileLink);
                        const w = fs.createWriteStream(filePath);
                        r.pipe(w);
                        w.on('finish', () => { copySuccess = true; resolve(); });
                        w.on('error', reject);
                        r.on('error', reject);
                    });
                } catch (e) {
                    console.error("Direct copy failed, falling back to HTTP:", e.message);
                }
            }

            // Fallback: If copy failed or file not found (permissions/mapping issue) -> Download via Local HTTP
            if (!copySuccess) {
                bot.editMessageText("⬇️ *Direct Copy Failed. Trying Local HTTP...*", {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    parse_mode: 'Markdown'
                });

                // Helper to get diverse URLs
                const getUrls = () => {
                    const urls = [];
                    // Ensure we have an IPv4 base if localhost is used
                    const bases = [baseApiUrl];
                    if (baseApiUrl.includes('localhost')) {
                         bases.push(baseApiUrl.replace('localhost', '127.0.0.1'));
                    }

                    // Prepare paths
                    let relativePath = fileLink;
                    if (fileLink.includes(token)) {
                        const parts = fileLink.split(token);
                        if (parts.length > 1) {
                            relativePath = parts[1];
                        }
                    }
                    // Clean relative path
                    let cleanRelative = relativePath;
                    if (cleanRelative.startsWith('/')) cleanRelative = cleanRelative.substring(1);
                    if (cleanRelative.startsWith('\\')) cleanRelative = cleanRelative.substring(1);

                    // Strategy 1: Standard Relative (file/bot<token>/videos/file.mp4)
                    bases.forEach(base => {
                         urls.push({
                             url: `${base}/file/bot${token}/${cleanRelative}`,
                             desc: `Standard Relative (${base})`
                         });
                    });

                    // Strategy 2: Absolute Path via detailed endpoint (file/bot<token>/var/lib/...)
                    bases.forEach(base => {
                        urls.push({
                            url: `${base}/file/bot${token}${fileLink}`,
                            desc: `Absolute via Endpoint (${base})`
                        });
                    });

                    // Strategy 3: Direct Absolute Path (No prefix) - /var/lib/...
                    // Some servers might serve root
                    bases.forEach(base => {
                        urls.push({
                            url: `${base}${fileLink}`,
                            desc: `Direct Absolute (${base})`
                        });
                    });

                    // Strategy 4: Relative Path WITHOUT Token (Custom setups)
                    // URL: http://localhost:8081/file/videos/file.mp4
                    bases.forEach(base => {
                        urls.push({
                            url: `${base}/file/${cleanRelative}`,
                            desc: `Relative No-Token (${base})`
                        });
                    });

                    return urls;
                };

                const strategies = getUrls();
                let params = null;
                let success = false;

                for (const strategy of strategies) {
                    console.log(`[Debug] Trying HTTP Strat: ${strategy.desc} -> ${strategy.url}`);
                    try {
                        const response = await axios({
                            url: strategy.url,
                            method: 'GET',
                            responseType: 'stream'
                        });
                        // If we get here, it worked
                        params = response;
                        success = true;
                        console.log(`[Debug] Success with Strategy: ${strategy.desc}`);
                        break;
                    } catch (e) {
                         console.error(`[Debug] Failed: ${e.message} (Status: ${e.response ? e.response.status : 'N/A'})`);
                         // Continue to next strategy
                    }
                }

                if (!success || !params) {
                     // Specific feedback if EACCES was the original cause
                     let msg = "All local HTTP download strategies failed.";
                     if (copySuccess === false) { // It was a failed copy
                         msg += "\n\n⚠️ **Permission Issue Detected**\nThe bot could not read the file directly ('Permission Denied'). Please check file permissions on the server.";
                     }
                     
                     throw new Error(msg);
                }

                const response = params;
                // Try header first, fallback to Telegram API file size
                let totalLength = response.headers['content-length'];
                if (!totalLength || isNaN(totalLength)) {
                     totalLength = file.file_size; // Fallback from bot.getFile()
                }

                let downloadedLength = 0;
                response.data.on('data', (chunk) => {
                    downloadedLength += chunk.length;
                    const now = Date.now();
                    if (now - lastUpdateListener > 2000) {
                        const percent = totalLength ? ((downloadedLength / totalLength) * 100).toFixed(1) : '0';
                        const mb = (downloadedLength / (1024 * 1024)).toFixed(2);
                        const totalMb = (totalLength / (1024 * 1024)).toFixed(2);
                        
                        bot.editMessageText(`⬇️ *Downloading (HTTP Local)...*\n\n${generateProgressBar(percent)} ${percent}%\n${mb} MB / ${totalMb} MB`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id,
                            parse_mode: 'Markdown'
                        }).catch(() => {});
                        lastUpdateListener = now;
                    }
                });

                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
            }
        }

        const fileSize = fs.statSync(filePath).size;
        if (fileSize === 0) throw new Error("File downloaded but is empty (0 bytes).");

        // 3. Upload to Drive
        bot.editMessageText(`☁️ *Starting Upload to Drive...*\nFile Size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`, {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
        });

        const res = await drive.files.create({
            requestBody: {
                name: fileName,
                // Request specific fields to ensure links are returned
                fields: 'id, name, webContentLink, webViewLink, size'
            },
            media: {
                mimeType: 'application/octet-stream',
                body: fs.createReadStream(filePath)
            }
        }, {
            // Axios config for upload progress
            onUploadProgress: (evt) => {
                const now = Date.now();
                if (now - lastUpdateListener > 2000) { // Update every 2s
                    const progress = (evt.loaded / evt.total) * 100;
                    const loadedMB = (evt.loaded / (1024 * 1024)).toFixed(2);
                    const totalMB = (evt.total / (1024 * 1024)).toFixed(2);

                    bot.editMessageText(`☁️ *Uploading to Drive...*\n\n${generateProgressBar(progress)} ${Math.round(progress)}%\n${loadedMB} MB / ${totalMB} MB`, {
                        chat_id: chatId,
                        message_id: statusMsg.message_id,
                        parse_mode: 'Markdown'
                    }).catch(() => { });
                    lastUpdateListener = now;
                }
            }
        });

        // 3. Set Permissions (Make it public so links work)
        await drive.permissions.create({
            fileId: res.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            }
        });

        // 4. Refetch file to get updated links (sometimes links appear after permission change)
        const finalFile = await drive.files.get({
            fileId: res.data.id,
            fields: 'webContentLink, webViewLink, size'
        });

        // Cleanup
        fs.unlinkSync(filePath);

        // Send Link
        const webContentLink = finalFile.data.webContentLink || res.data.webContentLink || "N/A";
        const webViewLink = finalFile.data.webViewLink || finalFile.data.alternateLink || res.data.webViewLink || "N/A";
        const finalSize = formatBytes(parseInt(finalFile.data.size || res.data.size || fileSize));

        // Format Detailed Message
        const caption = `
✅ *Upload Complete!*

📂 *Name:* \`${fileName}\`
💾 *Size:* \`${finalSize}\`
`;

        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, caption, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "📥 Download", url: webContentLink },
                        { text: "👁️ View", url: webViewLink }
                    ],
                    [
                        { text: "🗑️ Delete", callback_data: `del_drive_${res.data.id}` }
                    ]
                ]
            }
        });

    } catch (error) {
        console.error("GDrive Error:", error);
        bot.editMessageText(`❌ *Upload Failed:*\n${error.message}`, {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
        }).catch(() => {});
    } finally {
        // Cleanup: Always delete temp file
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
                console.log(`[Cleanup] Deleted temp file: ${filePath}`);
            } catch (e) {
                console.error(`[Cleanup Error] Failed to delete ${filePath}:`, e.message);
            }
        }
    }
});

// Handle Callback Queries (for Delete button)
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = message.chat.id;

    if (data.startsWith('del_drive_')) {
        const fileId = data.replace('del_drive_', '');
        
        // Authenticate
        const tokens = getGoogleToken(chatId);
        if (!tokens) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: "⚠️ You are not logged in/authorized.", show_alert: true });
        }

        const oAuth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            'http://localhost:3000/oauth2callback'
        );
        oAuth2Client.setCredentials(tokens);
        const drive = google.drive({ version: 'v3', auth: oAuth2Client });

        try {
            await drive.files.delete({ fileId: fileId });
            
            bot.answerCallbackQuery(callbackQuery.id, { text: "✅ File deleted from Drive." });
            
            // Edit message to remove buttons and show deleted status
            bot.editMessageText(`${message.text || message.caption}\n\n🗑️ *Deleted from Drive*`, {
                chat_id: chatId,
                message_id: message.message_id,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [] } // Remove buttons
            }).catch(() => {});

        } catch (error) {
            console.error("Delete Error:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: `❌ Failed to delete: ${error.message}`, show_alert: true });
        }
    }
});

bot.onText(/\/logout_mega/, (msg) => {
    updateUser(msg.chat.id, { mega_auth: null });
    bot.sendMessage(msg.chat.id, "✅ Mega credentials removed.");
});

bot.onText(/\/resume_mega/, async (msg) => {
    const chatId = msg.chat.id;
    const user = checkPlan(chatId);

    if (user.last_mega_job && user.last_mega_job.url) {
        // Unpause
        if (pausedJobs[chatId]) delete pausedJobs[chatId];

        // Resume with saved state (including useAuth if it was on, or start default false)
        const useAuth = user.last_mega_job.use_auth || false;

        bot.sendMessage(chatId, `🔄 Resuming download from file #${user.last_mega_job.processed_count + 1}...${useAuth ? ' (Authenticated)' : ''}`);
        processMegaFolder(chatId, user.last_mega_job.url, user.last_mega_job.processed_count, useAuth);
    } else {
        bot.sendMessage(chatId, "❌ No resumable Mega job found.");
    }
});


// --- File Link Logic ---
bot.onText(/\/fileLink/, async (msg) => {
    const chatId = msg.chat.id;

    if (!msg.reply_to_message) {
        return bot.sendMessage(chatId, "⚠️ Please reply to a file with /fileLink to get its direct link.");
    }

    const reply = msg.reply_to_message;
    let fileId;
    let fileSize = 0;

    if (reply.document) { fileId = reply.document.file_id; fileSize = reply.document.file_size; }
    else if (reply.video) { fileId = reply.video.file_id; fileSize = reply.video.file_size; }
    else if (reply.audio) { fileId = reply.audio.file_id; fileSize = reply.audio.file_size; }
    else if (reply.voice) { fileId = reply.voice.file_id; fileSize = reply.voice.file_size; }
    else if (reply.sticker) { fileId = reply.sticker.file_id; fileSize = reply.sticker.file_size; }
    else if (reply.photo && reply.photo.length > 0) {
        // Get the largest photo
        const photo = reply.photo[reply.photo.length - 1];
        fileId = photo.file_id;
        fileSize = photo.file_size;
    }

    if (!fileId) {
        return bot.sendMessage(chatId, "⚠️ The replied message does not contain a supported file.");
    }

    // Debug Message
    const isLocal = baseApiUrl.includes('localhost') || baseApiUrl.includes('127.0.0.1');
    bot.sendMessage(chatId, `🔍 Processing File...\nSize: ${formatBytes(fileSize)}\nAPI: ${isLocal ? 'Local Server' : 'Telegram Cloud'}`);

    try {
        const fileLink = await bot.getFileLink(fileId);
        bot.sendMessage(chatId, `🔗 *Direct Link Generated:*\n\n${fileLink}`, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
    } catch (error) {
        let msgText = `❌ Error generating link: ${error.message}`;

        if (error.message.includes('too big')) {
            msgText += `\n\n⚠️ *Reason:* The file is too large for the current API server.`;
            if (!isLocal) {
                msgText += `\n💡 *Solution:* You are using Telegram Cloud API (20MB limit). You MUST set 'TELEGRAM_API_URL' in .env to your Local API Server to handle large files.`;
            } else {
                msgText += `\n💡 *Solution:* Your Local Server is rejecting the file. \n1. Ensure you started the server with the \`--local\` flag (e.g., \`./telegram-bot-api --local ...\`).\n2. Standard Bot API Server limit is ~2GB. For 4GB, you may need a custom build or MTProto.`;
            }
        }

        bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
});

// --- Bypass Logic ---
bot.onText(/\/bypass (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match[1].trim();

    if (!url.startsWith('http')) {
        bot.sendMessage(chatId, "❌ Please provide a valid URL starting with http/https.");
        return;
    }

    const processingMsg = await bot.sendMessage(chatId, "⏳ *Processing Link...* \nThis may take up to 60 seconds.", { parse_mode: 'Markdown' });

    try {
        const finalLink = await bypassUrl(url);

        if (finalLink) {
            bot.editMessageText(`✅ *Bypass Successful!*\n\n🔗 [Open Link](${finalLink})\n\n\`${finalLink}\``, {
                chat_id: chatId,
                message_id: processingMsg.message_id,
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        } else {
            bot.editMessageText("❌ *Bypass Failed.*\nCould not extract final link.", {
                chat_id: chatId,
                message_id: processingMsg.message_id,
                parse_mode: 'Markdown'
            });
        }
    } catch (error) {
        bot.editMessageText(`❌ *Error:* ${error.message}`, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown'
        });
    }
});

// --- main Logic ---

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Force Join Check
    if (!(await isMember(msg.from.id))) {
        sendForceJoinMessage(chatId);
        return;
    }

    // Handle Rename State
    if (setupState[chatId] && setupState[chatId].state === 'WAITING_RENAME' && text && !text.startsWith('/')) {
        setupState[chatId].customName = text.trim();
        setupState[chatId].state = 'IDLE';
        bot.sendMessage(chatId, `✅ Name set to: \`${text.trim()}\`\n\nSelect action:`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: "⬇️ Start Upload", callback_data: "confirm_download" },
                    { text: "❌ Cancel", callback_data: "cancel_process" }
                ]]
            }
        });
        return;
    }

    // Handle Photo (Custom Thumb)
    if (msg.photo && setupState[chatId] && setupState[chatId].state === 'WAITING_THUMB') {
        const fileId = msg.photo[msg.photo.length - 1].file_id;

        try {
            const savedPath = await bot.downloadFile(fileId, downloadsDir);
            const thumbPath = path.join(downloadsDir, `custom_thumb_${chatId}.jpg`);

            // Move/Rename safely
            if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
            fs.renameSync(savedPath, thumbPath);

            setupState[chatId].customThumb = thumbPath;
            setupState[chatId].state = 'IDLE';
            bot.sendMessage(chatId, "✅ Cover set!\n\nSelect action:", {
                reply_markup: {
                    inline_keyboard: [[
                        { text: "⬇️ Start Upload", callback_data: "confirm_download" },
                        { text: "❌ Cancel", callback_data: "cancel_process" }
                    ]]
                }
            });
        } catch (e) {
            console.error("Thumb Download Error:", e);
            bot.sendMessage(chatId, `Failed to download thumb: ${e.message}`);
        }
        return;
    }

    if (!text || text.startsWith('/')) return;

    // Relaxed URL validation
    let targetUrl;
    try {
        targetUrl = new URL(text);
        if (!targetUrl.protocol.startsWith('http')) throw new Error('Invalid protocol');
    } catch (e) {
        // Only warn if not in a state
        if (!setupState[chatId]) bot.sendMessage(chatId, "Please send a valid HTTP/HTTPS URL.");
        return;
    }

    // Check Plan & Show Menu
    const user = checkPlan(chatId);

    // Setup Job Intent
    if (!setupState[chatId]) setupState[chatId] = {};
    setupState[chatId].pendingUrl = text;
    setupState[chatId].state = 'IDLE';

    // Free Plan -> Auto Start
    if (user.plan === 'free') {
        processDownload(chatId, text);
        delete setupState[chatId]; // Clear setup immediately
        return;
    }

    // Paid Plan -> Show Menu
    bot.sendMessage(chatId, "⚙️ *Download Options*", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "⬇️ Default Download", callback_data: "confirm_download" }
                ],
                [
                    { text: "✏️ Rename File", callback_data: "start_rename" },
                    { text: "🖼️ Custom Cover (Video)", callback_data: "start_thumb" }
                ],
                [
                    { text: "❌ Cancel", callback_data: "cancel_process" }
                ]
            ]
        }
    });
});

async function processDownload(chatId, urlText, customName = null, customThumb = null) {
    const targetUrl = new URL(urlText);
    const settings = { max_size_gb: 2 }; // Legacy compat

    // Check Plan Quota (Re-check for safety)
    const user = checkPlan(chatId);
    const limits = getPlanLimits(user.plan);

    // 1. Weekly Limit Check (Free only)
    if (user.plan === 'free' && user.downloads_this_week >= 3) {
        bot.sendMessage(chatId, "⚠️ *Weekly Limit Reached* (3/3)\n\nUpgrade to /plan for Unlimited Downloads!", { parse_mode: 'Markdown' });
        return;
    }

    // 2. Parallel Limits Check
    if (!userDownloads[chatId]) userDownloads[chatId] = [];
    if (userDownloads[chatId].length >= limits.parallel) {
        bot.sendMessage(chatId, `⚠️ *Parallel Limit Reached* (${userDownloads[chatId].length}/${limits.parallel})\n\nPlease wait for current downloads to finish or upgrade /plan.`, { parse_mode: 'Markdown' });
        return;
    }

    // Init Job
    const jobId = Date.now().toString() + Math.random().toString(36).substring(7);
    userDownloads[chatId].push(jobId);

    let statusMsg = await bot.sendMessage(chatId, "Initializing download...");
    let statusMsgId = statusMsg.message_id;
    let lastUpdate = Date.now();

    let filePath = null;

    try {
        const controller = new AbortController();

        // Register Running Job
        runningJobs[jobId] = {
            chatId,
            controller,
            filePath: null, // set later
            stream: null
        };

        const agent = new https.Agent({
            rejectUnauthorized: false,
            keepAlive: true
        });

        // Download with progress
        const response = await axios({
            url: urlText,
            method: 'GET',
            responseType: 'stream',
            timeout: 120000,
            signal: controller.signal,
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
        if (customName) {
            fileName = customName;
        } else {
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
                    fileName = decodeURIComponent(fileName);
                } catch (e) { }
            }
        }

        // Sanitize filename
        fileName = fileName.replace(/[<>:"/\\|?*]+/g, '_');

        filePath = path.join(downloadsDir, fileName);
        runningJobs[jobId].filePath = filePath;

        const writer = fs.createWriteStream(filePath);

        const totalLength = response.headers['content-length'];

        // CHECK SIZE LIMIT & DAILY BANDWIDTH
        if (totalLength) {
            const fileSizeGB = totalLength / (1024 * 1024 * 1024);
            const fileSizeBytes = parseInt(totalLength);

            // 1. File Size Limit
            if (fileSizeGB > limits.max_gb) {
                throw new Error(`File too large (${fileSizeGB.toFixed(2)} GB).\nYour Plan Limit: ${limits.max_gb} GB.\nUpgrade: /plan`);
            }

            // 2. Daily Bandwidth Limit
            const dailyUsageBytes = user.daily_usage || 0;
            const dailyLimitBytes = limits.daily_limit_gb * 1024 * 1024 * 1024;

            if (dailyUsageBytes + fileSizeBytes > dailyLimitBytes) {
                const usedGB = (dailyUsageBytes / (1024 * 1024 * 1024)).toFixed(2);
                throw new Error(`⚠️ *Daily Bandwidth Limit Reached*\n\nUsage: ${usedGB} GB / ${limits.daily_limit_gb} GB\n\nPlease wait for 12 AM IST reset or upgrade /plan.`);
            }

            // Commit usage (Optimistic increment)
            updateUser(chatId, { daily_usage: dailyUsageBytes + fileSizeBytes });
        }

        // Increment usage if passed checks (committed only when download truly starts)
        updateUser(chatId, { downloads_this_week: user.downloads_this_week + 1 });

        let downloadedLength = 0;
        let startTime = Date.now();

        // Update Cancellation Button to include jobId
        const cancelBtn = { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `cancel_${jobId}` }]] };

        response.data.on('data', (chunk) => {
            downloadedLength += chunk.length;
            const now = Date.now();
            if (now - lastUpdate > 3000) {
                const percent = totalLength ? ((downloadedLength / totalLength) * 100).toFixed(1) : '0';
                const speed = downloadedLength / ((now - startTime) / 1000);
                const speedStr = formatBytes(speed) + '/s';
                const progressStr = generateProgressBar(percent);

                bot.editMessageText(`⬇️ Downloading...\n${progressStr} ${percent}%\nSpeed: ${speedStr}\nSize: ${formatBytes(downloadedLength)} / ${formatBytes(totalLength)}`, {
                    chat_id: chatId,
                    message_id: statusMsgId,
                    reply_markup: cancelBtn
                }).catch(e => { }); // Ignore edit errors
                lastUpdate = now;
            }
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log("Download complete.");

        bot.editMessageText("Processing metadata...", { chat_id: chatId, message_id: statusMsgId }).catch(e => { });

        // --- Video Processing ---
        // Check if it's a video file using ffprobe
        let videoMeta = null;
        let thumbPath = customThumb || null; // Use custom if exists

        console.log("[Debug] Probing file for metadata...");

        try {
            await new Promise((resolve) => {
                fluentFfmpeg.ffprobe(filePath, (err, metadata) => {
                    if (err || !metadata) {
                        console.log("[Debug] Probing failed or not media:", err ? err.message : "no meta");
                        resolve();
                        return;
                    }

                    // Check for video stream
                    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                    if (videoStream) {
                        console.log("[Debug] Detected Video Stream.");
                        videoMeta = {
                            width: videoStream.width,
                            height: videoStream.height,
                            duration: Math.ceil(metadata.format.duration || 0)
                        };

                        // Generate thumbnail if NO custom thumb provided
                        if (!thumbPath) {
                            thumbPath = path.join(downloadsDir, `cover-thumb-${jobId}.jpg`);
                            fluentFfmpeg(filePath)
                                .on('end', () => resolve())
                                .on('error', () => resolve()) // Ignore error
                                .screenshots({
                                    count: 1,
                                    folder: downloadsDir,
                                    filename: `cover-thumb-${jobId}.jpg`,
                                    timemarks: ['10%'] // Take from 10% point
                                });
                        } else {
                            resolve();
                        }
                    } else {
                        resolve();
                    }
                });
            });

            // Generate extra screenshots if enabled and is video
            if (videoMeta && user.screenshots !== false) {
                if (videoMeta.duration > 0) {
                    console.log("[Debug] Generating 9 screenshots (Manual Parallel)...");
                    bot.editMessageText("Processing screenshots (Fast)...", { chat_id: chatId, message_id: statusMsgId }).catch(e => { });

                    // Helper to take ONE screenshot with fastSeek
                    const takeShot = (percent) => {
                        return new Promise((resolve) => {
                            const timestamp = Math.floor(videoMeta.duration * percent / 100);
                            const filename = `thumb-${jobId}-${percent}.jpg`;

                            fluentFfmpeg()
                                .input(filePath)
                                .inputOptions([`-ss ${timestamp}`]) // Input seeking (FAST)
                                .output(path.join(downloadsDir, filename))
                                .frames(1)
                                .on('end', () => resolve(true))
                                .on('error', (e) => {
                                    console.error(`[Debug] Shot ${percent}% failed:`, e.message);
                                    resolve(false);
                                })
                                .run();
                        });
                    };

                    const percents = [10, 20, 30, 40, 50, 60, 70, 80, 90];
                    // Run all 9 in parallel (input seeking is low CPU)
                    await Promise.all(percents.map(p => takeShot(p)));

                    const files = fs.readdirSync(downloadsDir).filter(f => f.startsWith(`thumb-${jobId}-`));
                    // Sort by number to keep order
                    files.sort((a, b) => {
                        const nA = parseInt(a.match(/-(\d+).jpg/)[1]);
                        const nB = parseInt(b.match(/-(\d+).jpg/)[1]);
                        return nA - nB;
                    });

                    const shots = files.map(f => path.join(downloadsDir, f));

                    if (shots.length > 0) {
                        console.log(`[Debug] Sending ${shots.length} screenshots immediately.`);
                        const mediaGroup = shots.map(p => ({ type: 'photo', media: p }));
                        await bot.sendMediaGroup(chatId, mediaGroup.slice(0, 10));
                        // Cleanup screenshots
                        shots.forEach(p => { try { fs.unlinkSync(p); } catch (e) { } });
                    }
                }
            }

        } catch (e) {
            console.error("[Debug] Metadata/Processing Error:", e);
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
                    message_id: statusMsgId,
                    reply_markup: cancelBtn
                }).catch(e => { });
                lastUpdate = now;
            }

            if (progress.percentage >= 100) {
                bot.editMessageText(`☁️ Syncing to Telegram Cloud...\n(This ensures the file is playable)\nPlease wait, this may take a few minutes.`, {
                    chat_id: chatId,
                    message_id: statusMsgId
                }).catch(e => { });
            }
        });

        // We have to stream specifically to pipe through 'progress-stream'
        // node-telegram-bot-api accepts a stream
        const fileStream = fs.createReadStream(filePath).pipe(str);
        runningJobs[jobId].stream = fileStream;

        fileStream.on('finish', () => console.log("[Debug] File stream finished piping."));
        fileStream.on('error', (e) => console.error("[Debug] File stream error:", e));

        // Generate Caption
        const caption = generateCaption(user.custom_caption, {
            filename: fileName,
            filesize: formatBytes(fileStat.size),
            duration: videoMeta ? formatTime(videoMeta.duration) : 'N/A',
            extension: path.extname(fileName)
        });

        // Send Video if detected as video, else Document
        if (videoMeta) {
            console.log("[Debug] Sending as Video with meta:", videoMeta);
            const opts = {
                caption: caption,
                duration: videoMeta.duration,
                width: videoMeta.width,
                height: videoMeta.height,
                supports_streaming: true
            };
            if (thumbPath && fs.existsSync(thumbPath)) {
                opts.thumb = thumbPath; // Pass path
            }

            const sentMsg = await bot.sendVideo(chatId, fileStream, opts, { filename: fileName });

            // Dump Channel Forwarding
            const settings = getSettings();
            if (settings.dump_channel_id && sentMsg) {
                bot.copyMessage(settings.dump_channel_id, chatId, sentMsg.message_id).catch(e => console.error("Dump Error:", e.message));
            }

        } else {
            const opts = {
                caption: caption
            };
            const sentMsg = await bot.sendDocument(chatId, fileStream, opts, { filename: fileName });

            // Dump Channel Forwarding
            const settings = getSettings();
            if (settings.dump_channel_id && sentMsg) {
                bot.copyMessage(settings.dump_channel_id, chatId, sentMsg.message_id).catch(e => console.error("Dump Error:", e.message));
            }
        }
        console.log("[Debug] Main file sent to Telegram.");

        // Cleanup thumbnails
        if (thumbPath && fs.existsSync(thumbPath)) {
            try { fs.unlinkSync(thumbPath); } catch (e) { }
        }

        // Cleanup main file
        fs.unlinkSync(filePath);
        bot.deleteMessage(chatId, statusMsgId).catch(e => { }); // Clean up status message

    } catch (error) {
        if (axios.isCancel(error)) {
            bot.editMessageText("❌ Process Cancelled.", { chat_id: chatId, message_id: statusMsgId });
            return;
        }

        console.error("Error processing link:", error.message);
        let errorMessage = error.message;
        if (error.code === 'ETIMEDOUT') errorMessage = "Connection timed out.";
        bot.sendMessage(chatId, `Failed: ${errorMessage}`);
        // Cleanup if needed
        if (filePath && fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) { }
        }
    } finally {
        delete runningJobs[jobId];
        userDownloads[chatId] = userDownloads[chatId].filter(id => id !== jobId);
        if (userDownloads[chatId].length === 0) delete userDownloads[chatId];
    }
}

const pausedJobs = {}; // { chatId: { url, processed_count, folder_data_cache? } }

bot.onText(/\/mega (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;

    // Force Join Check
    if (!(await isMember(msg.from.id))) {
        sendForceJoinMessage(chatId);
        return;
    }

    const urlText = match[1].trim();

    // Clear any previous pause state for this new link
    if (pausedJobs[chatId]) delete pausedJobs[chatId];

    // New job starts at 0
    processMegaFolder(chatId, urlText, 0);
});

async function processMegaFolder(chatId, folderUrl, startIndex = 0, useAuth = false) {
    let statusMsgId = null;
    const user = checkPlan(chatId);

    // Check Parallel Limit (Mega folder takes 1 slot)
    const limits = getPlanLimits(user.plan);
    if (!userDownloads[chatId]) userDownloads[chatId] = [];
    if (userDownloads[chatId].length >= limits.parallel) {
        bot.sendMessage(chatId, `⚠️ *Parallel Limit Reached* (${userDownloads[chatId].length}/${limits.parallel})\nPlease wait or upgrade /plan.`, { parse_mode: 'Markdown' });
        return;
    }

    // Initialize/Update Job State in DB
    updateUser(chatId, {
        last_mega_job: {
            url: folderUrl,
            processed_count: startIndex,
            updated_at: Date.now(),
            use_auth: useAuth
        }
    });

    const jobId = Date.now().toString() + Math.random().toString(36).substring(7);
    userDownloads[chatId].push(jobId);

    // Control Flag for Loop
    let isPaused = false;
    let switchedToAuth = false; // Flag to indicate we need to restart with auth

    try {
        const statusMsg = await bot.sendMessage(chatId, `🔄 Connecting to Mega.nz...${useAuth ? ' (Authenticated)' : ''}`);
        statusMsgId = statusMsg.message_id;

        // 1. Connect & Load
        let folder;
        let storage = null; // Keep reference to close if needed

        try {
            if (useAuth && user.mega_auth) {
                storage = new Storage({
                    email: user.mega_auth.email,
                    password: user.mega_auth.password
                });
                await new Promise((resolve, reject) => {
                    storage.once('ready', resolve);
                    storage.once('error', reject);
                });
                folder = File.fromURL(folderUrl);
            } else {
                folder = File.fromURL(folderUrl);
            }

            await folder.loadAttributes();
        } catch (e) {
            throw new Error("Invalid Mega Link or API Error.");
        }

        // 2. Traverse & Count
        let filesToProcess = [];
        let totalBytes = 0;

        function traverse(node) {
            if (node.children) {
                node.children.forEach(traverse);
            } else {
                filesToProcess.push(node);
                totalBytes += (node.size || 0);
            }
        }
        traverse(folder);

        if (filesToProcess.length === 0) {
            bot.editMessageText("⚠️ Folder is empty.", { chat_id: chatId, message_id: statusMsgId });
            return;
        }

        bot.editMessageText(`✅ Found ${filesToProcess.length} files (${formatBytes(totalBytes)}).\nStarting sequential download...`,
            { chat_id: chatId, message_id: statusMsgId });

        // 3. Process Sequentially
        let processedBytes = 0; // Approximate for UI
        let processedCount = 0; // Actual iterator

        const totalCount = filesToProcess.length;
        const startTimeGlobal = Date.now();

        // Loop using index
        for (let i = 0; i < totalCount; i++) {
            // Check Pause State externally (via pausedJobs check or signal)
            if (pausedJobs[chatId] && pausedJobs[chatId].command === 'PAUSE') {
                isPaused = true;
                break; // Exit loop to "Pause" state
            }

            const fileNode = filesToProcess[i];

            // SKIP LOGIC
            // If resuming (startIndex > 0), skip until we hit startIndex
            if (i < startIndex) {
                processedBytes += (fileNode.size || 0);
                processedCount++;
                continue;
            }

            const fileName = fileNode.name;
            const fileSize = fileNode.size || 0;

            // Validate Plan Limits per file (optional, strict for now)
            const fileSizeGB = fileSize / (1024 * 1024 * 1024);
            if (fileSizeGB > limits.max_gb) {
                bot.sendMessage(chatId, `⚠️ Skipped ${fileName}: Too large (${fileSizeGB.toFixed(2)} GB) for your plan.`);
                processedCount++;
                processedBytes += fileSize;
                continue;
            }

            // Update Status for Current File
            const globalPercent = totalBytes > 0 ? ((processedBytes / totalBytes) * 100).toFixed(1) : 0;

            // Re-usable status updater
            // Re-usable status updater
            let lastUiUpdate = 0;
            const updateStatus = (action, speed = 0, currentPercent = 0, force = false) => {
                const now = Date.now();
                // Throttle updates: Max once per 3s unless forced (init/complete)
                if (!force && now - lastUiUpdate < 3000) return;

                lastUiUpdate = now;

                // If paused, don't update UI with active stats (avoid race conditions)
                if (pausedJobs[chatId] && pausedJobs[chatId].command === 'PAUSE') return;

                const elapsed = (now - startTimeGlobal) / 1000;
                const avgSpeed = elapsed > 0 ? processedBytes / elapsed : 0;
                const estimatedTotalTime = avgSpeed > 0 ? (totalBytes - processedBytes) / avgSpeed : 0; // Remaining bytes / speed
                const remainingTime = Math.max(0, estimatedTotalTime);

                const statusText = `📂 *Mega.nz Batch*\n` +
                    `Files: ${processedCount + 1}/${totalCount}\n` +
                    `Total Progress: ${globalPercent}%\n` +
                    `ETA: ${formatTime(remainingTime)}\n\n` +
                    `📄 *Current File:* ${fileName}\n` +
                    `${action}: ${currentPercent}%\n` +
                    `${generateProgressBar(currentPercent)}\n` +
                    `Speed: ${formatBytes(speed)}/s`;

                // Add Pause Button
                const opts = {
                    chat_id: chatId,
                    message_id: statusMsgId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "⏸️ Pause", callback_data: "pause_mega" }
                        ]]
                    }
                }

                bot.editMessageText(statusText, opts).catch((e) => {
                    // Ignore "message is not modified" errors
                    if (!e.message.includes('message is not modified')) console.error("UI Update Error:", e.message);
                });
            };

            // Download & Upload Retry Loop
            let attempts = 0;
            const maxAttempts = 3;
            let success = false;
            const tempPath = path.join(downloadsDir, fileName.replace(/[<>:"/\\|?*]+/g, '_')); // Sanitize

            while (attempts < maxAttempts && !success) {
                attempts++;

                // Reset/Check pause before retry
                if (pausedJobs[chatId] && pausedJobs[chatId].command === 'PAUSE') {
                    isPaused = true;
                    try { fs.unlinkSync(tempPath); } catch (e) { };
                    break;
                }

                try {
                    updateStatus("⬇️ Downloading" + (attempts > 1 ? ` (Retry ${attempts})` : ""));

                    // Download to Disk - STABILITY PARAMS
                    // maxConnections: 1 (Sequential chunks prevents MAC verification errors)
                    // initialChunkSize: 256KB (Standard)
                    // chunkSize: 1MB (Standard)
                    // Prepare Target Node
                    let targetNode = fileNode;
                    let importedFile = null;

                    if (useAuth && storage) {
                        // API SWAP STRATEGY
                        // Instead of importing (which fails with ENOENT for folder children), 
                        // we simply use the Authenticated API to fetch the download URL.
                        // This consumes User Quota because the request is authenticated.
                        console.log(`[Mega] Switching to Authenticated API for ${fileName}...`);

                        // Debug Node Structure
                        try {
                            console.log(`[Mega] File Node Properties:`, Object.keys(fileNode));
                            console.log(`[Mega] ID: ${fileNode.id}, Handle: ${fileNode.handle}, Key: ${fileNode.key ? 'Present' : 'Missing'}`);
                        } catch (e) { }

                        // Debug Quota
                        try {
                            const info = await storage.getAccountInfo();
                            console.log(`[Mega] Account Quota: Used ${formatBytes(info.used || 0)} / Total ${formatBytes(info.total || 0)}`);
                        } catch (e) { console.warn("[Mega] Failed to check quota:", e.message); }

                        targetNode.api = storage.api;
                    }

                    // Download to Disk - STABILITY PARAMS
                    // maxConnections: 1 (Sequential chunks prevents MAC verification errors)
                    // initialChunkSize: 256KB (Standard)
                    // chunkSize: 1MB (Standard)
                    const downloadStream = targetNode.download({
                        maxConnections: 1,
                        initialChunkSize: 262144,
                        chunkSize: 1048576,
                        forceHttps: true // Ensure HTTPS
                    });

                    const writer = fs.createWriteStream(tempPath);

                    // Track Download Progress & HANG DETECTION
                    let lastActivity = Date.now();
                    const HANG_TIMEOUT = 45000; // 45s timeout

                    const hangCheckInterval = setInterval(() => {
                        if (Date.now() - lastActivity > HANG_TIMEOUT) {
                            downloadStream.emit('error', new Error("Download Hung (No Data)"));
                        }
                    }, 5000);

                    const dlStr = progress({ length: fileSize, time: 2000 });
                    dlStr.on('progress', (p) => {
                        lastActivity = Date.now();
                        updateStatus("⬇️ Downloading" + (attempts > 1 ? ` (Retry ${attempts})` : ""), p.speed, p.percentage.toFixed(1));
                    });

                    // Store controller for PAUSE
                    runningJobs[jobId] = {
                        chatId,
                        stream: downloadStream,
                        filePath: tempPath
                    };

                    // Pipe: Mega -> Progress -> File
                    downloadStream.pipe(dlStr).pipe(writer);

                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                        downloadStream.on('error', reject);
                        downloadStream.on('close', () => { });
                    });

                    clearInterval(hangCheckInterval);

                    // Cleanup Imported File from Cloud Drive (Important!)
                    if (importedFile) {
                        importedFile.delete().catch(e => console.error("Failed to delete temp imported file:", e.message));
                    }

                    // --- Video Processing for Mega ---
                    let videoMeta = null;
                    let thumbPath = null;

                    // Only probe if it looks like a video
                    if (['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(path.extname(tempPath).toLowerCase())) {
                        updateStatus("🎥 Processing metadata...", 0, 0, true);
                        try {
                            await new Promise((resolve) => {
                                fluentFfmpeg.ffprobe(tempPath, (err, metadata) => {
                                    if (err || !metadata) {
                                        console.log("[Mega] Probing failed:", err ? err.message : "no meta");
                                        resolve();
                                        return;
                                    }

                                    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                                    if (videoStream) {
                                        videoMeta = {
                                            width: videoStream.width,
                                            height: videoStream.height,
                                            duration: Math.ceil(metadata.format.duration || 0)
                                        };

                                        // Generate Thumbnail
                                        thumbPath = path.join(downloadsDir, `cover-thumb-${jobId}.jpg`);
                                        fluentFfmpeg(tempPath)
                                            .on('end', () => resolve())
                                            .on('error', () => resolve())
                                            .screenshots({
                                                count: 1,
                                                folder: downloadsDir,
                                                filename: `cover-thumb-${jobId}.jpg`,
                                                timemarks: ['10%'] // 10% point, full resolution
                                            });
                                    } else {
                                        resolve();
                                    }
                                });
                            });
                        } catch (e) {
                            console.error("[Mega] Metadata Error:", e.message);
                        }
                    }

                    // Upload Logic
                    updateStatus("⬆️ Uploading", 0, 0, true);

                    const upStr = progress({ length: fileSize, time: 2000 });
                    upStr.on('progress', (p) => {
                        updateStatus("⬆️ Uploading", p.speed, p.percentage.toFixed(1));
                    });

                    const uploadStream = fs.createReadStream(tempPath).pipe(upStr);
                    const isVideo = !!videoMeta;
                    let sentMsgMega = null;

                    if (isVideo) {
                        const opts = {
                            caption: fileName,
                            duration: videoMeta.duration,
                            width: videoMeta.width,
                            height: videoMeta.height,
                            supports_streaming: true
                        };
                        if (thumbPath && fs.existsSync(thumbPath)) {
                            opts.thumb = thumbPath;
                        }
                        sentMsgMega = await bot.sendVideo(chatId, uploadStream, opts, { filename: fileName });
                    } else {
                        sentMsgMega = await bot.sendDocument(chatId, uploadStream, { caption: fileName }, { filename: fileName });
                    }

                    // Cleanup Thumb
                    if (thumbPath && fs.existsSync(thumbPath)) {
                        try { fs.unlinkSync(thumbPath); } catch (e) { }
                    }

                    // Dump Channel Forwarding
                    const settings = getSettings();
                    if (settings.dump_channel_id && sentMsgMega) {
                        bot.copyMessage(settings.dump_channel_id, chatId, sentMsgMega.message_id).catch(e => console.error("Dump Error:", e.message));
                    }

                    success = true; // Mark as done

                } catch (err) {
                    // Ensure hangCheckInterval is cleared on error
                    if (typeof hangCheckInterval !== 'undefined') {
                        clearInterval(hangCheckInterval);
                    }

                    // Check if Paused (intentional abort)
                    if (pausedJobs[chatId] && pausedJobs[chatId].command === 'PAUSE') {
                        isPaused = true;
                        try { fs.unlinkSync(tempPath); } catch (e) { };
                        break; // Break retry loop
                    }

                    console.error(`Attempt ${attempts} failed for ${fileName}:`, err.message);

                    // Cleanup partial file before retry
                    try { fs.unlinkSync(tempPath); } catch (e) { }

                    // SPECIFIC ERROR HANDLERS
                    if (err.message.includes("Bandwidth limit reached")) {
                        // Fetch fresh user state (in case they logged in during download)
                        const freshUser = checkPlan(chatId);

                        // FALLBACK LOGIC
                        if (!useAuth && freshUser.mega_auth) {
                            bot.sendMessage(chatId, "⚠️ *Bandwidth Limit Reached* on Free Quota.\n🔄 Switching to your Mega Account...", { parse_mode: 'Markdown' });
                            switchedToAuth = true;
                            isPaused = true;
                            pausedJobs[chatId] = { command: 'SWITCH_AUTH' };
                            break;
                        } else if (useAuth) {
                            bot.sendMessage(chatId, "⚠️ *Account Bandwidth Limit Reached*\nYour Mega account quota is also exhausted.", { parse_mode: 'Markdown' });
                        }

                        const secondsMatch = err.message.match(/(\d+) seconds/);
                        const seconds = secondsMatch ? parseInt(secondsMatch[1]) : 0;
                        const waitTime = formatTime(seconds);

                        // Only send valid wait time or generic message
                        const waitMsg = waitTime ? `Mega requires a wait of approximately *${waitTime}*.` : "Mega has temporarily blocked this IP/Account.";

                        bot.sendMessage(chatId, `⏳ *Mega Bandwidth Limit Reached*\n\nThe bot has been auto-paused.\n${waitMsg}\n\nYou can click 'Resume' later.`, { parse_mode: 'Markdown' });

                        isPaused = true;
                        // Set implicit pause state so retry loop breaks
                        // Ensure we don't overwrite a pending switch (though break should prevent this)
                        if (!pausedJobs[chatId] || pausedJobs[chatId].command !== 'SWITCH_AUTH') {
                            pausedJobs[chatId] = { command: 'PAUSE_AUTO' };
                        }
                        break; // Break retry loop
                    }

                    if (attempts >= maxAttempts) {
                        // SKIP logic instead of Throw
                        bot.sendMessage(chatId, `❌ Failed to download *${fileName}* after ${maxAttempts} attempts. Moving to next file...`, { parse_mode: 'Markdown' });
                        // Do NOT throw. Proceed to next file.
                    } else {
                        // Short wait before retry
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
            }

            // If checking isPaused from inner loop break (Manual or Auto or Switch)
            if (isPaused) break; // Break main loop

            // If success is false but we finished retries, it means we SKIPPED.
            // So we just continue.

            // Cleanup (if success or skipped)
            try { fs.unlinkSync(tempPath); } catch (e) { }

            processedCount++;

            // Update Persistence
            updateUser(chatId, {
                last_mega_job: {
                    url: folderUrl,
                    processed_count: processedCount,
                    updated_at: Date.now(),
                    use_auth: useAuth
                }
            });
        }

        if (isPaused) {
            // Check for Switch
            if (pausedJobs[chatId] && pausedJobs[chatId].command === 'SWITCH_AUTH') {
                // Restart immediately with Auth
                // Delete pause state so it doesn't pause new job
                delete pausedJobs[chatId];
                // Recursive call (async)
                processMegaFolder(chatId, folderUrl, processedCount, true);
                return; // Exit this instance
            }

            bot.editMessageText(`⏸️ *Job Paused*\n\nProcessed: ${processedCount}/${totalCount}\n\nClick Resume to continue from file #${processedCount + 1}.`, {
                chat_id: chatId,
                message_id: statusMsgId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: "▶️ Resume", callback_data: "resume_mega" }
                    ]]
                }
            });
            // State is already saved in DB (processed_count)
        } else {
            bot.editMessageText("✅ Mega Folder Download Complete!", { chat_id: chatId, message_id: statusMsgId });
            // Clear job
            updateUser(chatId, { last_mega_job: null });
        }

    } catch (e) {
        console.error(e);
        const text = `❌ Error: ${e.message}\n\nThis might be a temporary network issue or a bad link.`;

        const resumeBtn = {
            inline_keyboard: [[
                { text: "🔄 Resume Download", callback_data: "resume_mega" }
            ]]
        };

        if (statusMsgId) {
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: statusMsgId,
                reply_markup: resumeBtn
            }).catch(() => { });
        } else {
            bot.sendMessage(chatId, text, { reply_markup: resumeBtn });
        }

    } finally {
        userDownloads[chatId] = userDownloads[chatId].filter(id => id !== jobId);
        if (userDownloads[chatId].length === 0) delete userDownloads[chatId];
        delete runningJobs[jobId];
    }
}

console.log("Bot is running...");

// System Status Command
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;

    // Uptime
    const uptime = formatTime(process.uptime());
    const osUptime = formatTime(os.uptime());

    // RAM
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = ((usedMem / totalMem) * 100).toFixed(1);

    // CPU
    const cpus = os.cpus();
    const cpuModel = cpus[0] ? cpus[0].model : 'Unknown';
    const cpuCores = cpus.length;
    const loadAvg = os.loadavg(); // [1, 5, 15] min

    // Disk (Async)
    const getDisk = () => new Promise(resolve => {
        if (process.platform !== 'win32') {
            // Get stats for current directory mount
            exec('df -h .', (err, stdout) => {
                if (err) return resolve('Unknown');
                const lines = stdout.trim().split('\n');
                if (lines.length > 1) {
                    // Usually: Filesystem Size Used Avail Use% Mounted on
                    return resolve(lines[lines.length - 1].replace(/\s+/g, ' '));
                }
                resolve('Unknown');
            });
        } else {
            exec('wmic logicaldisk get size,freespace,caption', (err, stdout) => {
                if (err) return resolve('Windows N/A');
                resolve(stdout.trim().split('\n').slice(1).map(l => l.trim()).join(' | '));
            });
        }
    });

    const diskInfo = await getDisk();

    // Bot Stats
    const activeJobs = Object.keys(runningJobs).length;
    let queuedItems = 0;
    if (userDownloads) {
        Object.values(userDownloads).forEach(arr => queuedItems += (arr ? arr.length : 0));
    }

    const statusMsg = `🖥️ *System Status*

🕒 *Uptime:* ${uptime} (Bot)
💻 *OS:* ${os.type()} ${os.release()} (${os.arch()})

🧠 *RAM:* ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memUsage}%)
⚙️ *CPU:* ${cpuCores}x ${cpuModel}
📊 *Load:* ${loadAvg.map(l => l.toFixed(2)).join(', ')}

💾 *Disk:*
\`${diskInfo}\`

🤖 *Bot Performance*
📥 Active Jobs: ${activeJobs}
cnt Pending Queue: ${queuedItems}
`;

    bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown' });
});
