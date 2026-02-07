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
console.log(`Bot will ${baseApiUrl.includes('localhost') ? 'use LOCAL' : 'use REMOTE'} Telegram API server`);

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

// Helper function to extract timestamp from Telegram file ID
function extractTimestampFromFileId(fileId) {
    try {
        // Telegram file IDs contain base64-encoded data with timestamps
        // This is a rough approximation - file IDs are complex structures
        const parts = fileId.split('AA');
        if (parts.length > 1) {
            // Try to extract timestamp-like data from the file ID
            // This is heuristic and may not be 100% accurate
            const encoded = parts[1].substring(0, 8);
            const decoded = Buffer.from(encoded, 'base64');
            if (decoded.length >= 4) {
                return decoded.readUInt32BE(0);
            }
        }
    } catch (e) {
        // If extraction fails, assume current time (recent file)
        console.log(`[Debug] Could not extract timestamp from file ID: ${e.message}`);
    }
    return Math.floor(Date.now() / 1000); // Default to current time
}

// Ensure the 'downloads' directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Helper to resolve local file paths mapping from Docker
function resolveLocalFilePath(fileLink) {
    if (!fileLink) return null;
    
    // Check if it's already an absolute path (internal to container)
    let isAbsolute = fileLink.startsWith('/') || (fileLink.match(/^[a-zA-Z]:/) !== null);
    
    const localApiMount = process.env.LOCAL_API_PATH || '/var/lib/telegram-bot-api';
    const tgDataPath = path.join(__dirname, 'tg-data');
    
    let candidates = [];
    
    if (isAbsolute) {
        // Strategy 1: Translate container-side absolute path
        if (fileLink.startsWith(localApiMount)) {
            const relativePart = fileLink.substring(localApiMount.length);
            candidates.push(path.join(tgDataPath, relativePart));
            // Try with token if it's not already there
            if (!relativePart.includes(token)) {
                 candidates.push(path.join(tgDataPath, token, relativePart));
            }
        }
        candidates.push(fileLink);
    } else {
        // Strategy 3: Relative path
        candidates.push(path.join(tgDataPath, token, fileLink));
        candidates.push(path.join(tgDataPath, `bot${token}`, fileLink));
        candidates.push(path.join(tgDataPath, fileLink));
    }
    
    // Filter duplicates and undefined
    candidates = [...new Set(candidates.filter(c => c))];

    for (const cand of candidates) {
        console.log(`[Resolve] Checking candidate: ${cand}`);
        try {
            if (fs.existsSync(cand)) {
                console.log(`[Resolve] SUCCESS: Found file at: ${cand}`);
                return cand;
            }
        } catch (e) {
            console.log(`[Resolve] Error checking ${cand}: ${e.message}`);
        }
    }
    
    console.log(`[Resolve] FAILED: File not found in candidates for: ${fileLink}`);
    // Diagnostic log
    if (fs.existsSync(tgDataPath)) {
        try {
            const list = fs.readdirSync(tgDataPath);
            console.log(`[Resolve] tg-data contents: [${list.join(', ')}]`);
            const botFolder = list.find(f => f.includes(token.split(':')[0]));
            if (botFolder) {
                const botPath = path.join(tgDataPath, botFolder);
                const subList = fs.readdirSync(botPath);
                console.log(`[Resolve] Inside ${botFolder}: [${subList.join(', ')}]`);
                if (subList.includes('videos')) {
                    const videoList = fs.readdirSync(path.join(botPath, 'videos'));
                    console.log(`[Resolve] Inside videos folder: [${videoList.join(', ')}]`);
                }
            }
        } catch (e) {
            console.log(`[Resolve] Debug list failed: ${e.message}`);
        }
    } else {
        console.log(`[Resolve] tg-data folder missing at: ${tgDataPath}`);
    }
    return null;
}

bot.on('polling_error', (error) => {
    console.error(`[polling_error] ${error.code}: ${error.message}`);
});

// --- Commands ---

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpText = `🤖 **DirectLink Bot Commands**

📥 **File Operations:**
• /link - Reply to any file to get direct download link
• /gdrive_add - Upload file to Google Drive
• /check_file - Test if file is compatible

🔗 **Google Drive:**
• /gdrive - Connect your Google Drive account
• /gdrive_status - Check connection status

🔧 **Utilities:**
• /test_api - Test API server connection
• /bypass <url> - Bypass shortened URLs
• /plan - View subscription plans
• /settings - Bot configuration

💡 **Tips:**
• Upload files directly to bot (don't forward)
• Use /link for fast direct downloads
• Files up to 2GB supported with local server

🆘 **Need Help?**
• /help_upload - File upload guide
• Contact: @sadsoul_main`;

    bot.sendMessage(chatId, helpText);
});

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

bot.onText(/\/help_upload/, (msg) => {
    const chatId = msg.chat.id;
    const helpText = `📤 **How to Upload Files for Google Drive**

✅ **CORRECT WAY:**
1. Select the file from your device
2. Send it directly to this bot
3. Use /gdrive_add command

❌ **AVOID:**
• Forwarding files from other chats
• Using old files (uploaded hours ago)

🔧 **If Upload Fails:**
1. Download the file to your device
2. Re-upload it directly to this bot
3. Try /gdrive_add again

💡 **Pro Tips:**
• Use /check_file to test compatibility
• Files up to 2GB are supported
• Fresh uploads work best

🤖 **Why This Happens:**
The bot can only access files that were uploaded directly to it after the server started running.`;

    bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/check_file/, async (msg) => {
    const chatId = msg.chat.id;

    if (!msg.reply_to_message) {
        return bot.sendMessage(chatId, "⚠️ Reply to a file with /check_file to check its compatibility.");
    }

    const reply = msg.reply_to_message;
    let fileId, fileName, fileSize;

    if (reply.document) {
        fileId = reply.document.file_id;
        fileName = reply.document.file_name;
        fileSize = reply.document.file_size;
    } else if (reply.video) {
        fileId = reply.video.file_id;
        fileName = reply.video.file_name || 'video.mp4';
        fileSize = reply.video.file_size;
    } else if (reply.audio) {
        fileId = reply.audio.file_id;
        fileName = reply.audio.file_name || 'audio.mp3';
        fileSize = reply.audio.file_size;
    } else if (reply.photo && reply.photo.length > 0) {
        const photo = reply.photo[reply.photo.length - 1];
        fileId = photo.file_id;
        fileName = 'photo.jpg';
        fileSize = photo.file_size;
    }

    if (!fileId) return bot.sendMessage(chatId, "❌ No file found.");

    const fileSizeMB = fileSize ? (fileSize / (1024 * 1024)).toFixed(2) : 'Unknown';

    // Test if file is accessible
    try {
        const file = await bot.getFile(fileId);
        bot.sendMessage(chatId, `✅ **File Compatible**\n\nName: ${fileName}\nSize: ${fileSizeMB} MB\nStatus: Ready for Google Drive upload\n\nUse /gdrive_add to upload this file.`);
    } catch (err) {
        const fileAge = Math.floor(Date.now() / 1000) - extractTimestampFromFileId(fileId);
        const ageHours = Math.floor(fileAge / 3600);

        bot.sendMessage(chatId, `❌ **File Not Compatible**\n\nName: ${fileName}\nSize: ${fileSizeMB} MB\nAge: ~${ageHours} hours\nStatus: Not available on local server\n\n**Solution:** Re-upload this file directly to the bot, then try /gdrive_add again.`);
    }
});

bot.onText(/\/debug_file/, async (msg) => {
    const chatId = msg.chat.id;

    if (!msg.reply_to_message) {
        return bot.sendMessage(chatId, "⚠️ Reply to a file with /debug_file to debug it.");
    }

    const reply = msg.reply_to_message;
    let fileId, fileName, fileSize;

    if (reply.document) {
        fileId = reply.document.file_id;
        fileName = reply.document.file_name;
        fileSize = reply.document.file_size;
    } else if (reply.video) {
        fileId = reply.video.file_id;
        fileName = reply.video.file_name || 'video.mp4';
        fileSize = reply.video.file_size;
    } else if (reply.audio) {
        fileId = reply.audio.file_id;
        fileName = reply.audio.file_name || 'audio.mp3';
        fileSize = reply.audio.file_size;
    } else if (reply.photo && reply.photo.length > 0) {
        const photo = reply.photo[reply.photo.length - 1];
        fileId = photo.file_id;
        fileName = 'photo.jpg';
        fileSize = photo.file_size;
    }

    if (!fileId) return bot.sendMessage(chatId, "❌ No file found.");

    const fileSizeMB = fileSize ? (fileSize / (1024 * 1024)).toFixed(2) : 'Unknown';

    let debugInfo = `🔍 **File Debug Info**\n\n`;
    debugInfo += `📁 **Name:** ${fileName.length > 30 ? fileName.substring(0, 30) + '...' : fileName}\n`;
    debugInfo += `💾 **Size:** ${fileSizeMB} MB\n`;
    debugInfo += `🆔 **File ID:** \`${fileId.substring(0, 20)}...\`\n`;
    debugInfo += `🌐 **API:** Local (${baseApiUrl})\n\n`;

    // Test Local API
    try {
        console.log(`[Debug] Testing Local API for file: ${fileId}`);
        const localFile = await bot.getFile(fileId);
        debugInfo += `✅ **Local API:** Success\n`;
        debugInfo += `📂 **Path:** \`${localFile.file_path}\`\n`;
        debugInfo += `💾 **Reported Size:** ${localFile.file_size ? (localFile.file_size / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown'}\n\n`;
    } catch (localErr) {
        debugInfo += `❌ **Local API:** Failed\n`;
        debugInfo += `🚫 **Error:** ${localErr.message}\n\n`;

        // Test Cloud API
        try {
            console.log(`[Debug] Testing Cloud API fallback for file: ${fileId}`);
            const cloudResp = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
            if (cloudResp.data && cloudResp.data.ok) {
                debugInfo += `☁️ **Cloud API:** Success\n`;
                debugInfo += `📂 **Path:** \`${cloudResp.data.result.file_path}\`\n`;
                debugInfo += `💾 **Reported Size:** ${cloudResp.data.result.file_size ? (cloudResp.data.result.file_size / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown'}\n`;
            } else {
                debugInfo += `☁️ **Cloud API:** Failed - ${JSON.stringify(cloudResp.data)}\n`;
            }
        } catch (cloudErr) {
            const cloudMsg = cloudErr.response ? JSON.stringify(cloudErr.response.data) : cloudErr.message;
            debugInfo += `☁️ **Cloud API:** Failed - ${cloudMsg}\n`;
        }
    }

    debugInfo += `\n**Recommendations:**\n`;
    if (fileSize > 20 * 1024 * 1024) {
        debugInfo += `• File is >20MB - requires Local API\n`;
    }
    debugInfo += `• Try re-uploading the file directly to this bot\n`;
    debugInfo += `• Use /test_api to verify API connection`;

    bot.sendMessage(chatId, debugInfo);
});

bot.onText(/\/test_api/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        // Test the API connection
        const response = await axios.get(`${baseApiUrl}/bot${token}/getMe`);

        if (response.data && response.data.ok) {
            const botInfo = response.data.result;
            bot.sendMessage(chatId, `✅ **API Connection Test**\n\n🤖 **Bot:** ${botInfo.first_name}\n🆔 **ID:** ${botInfo.id}\n🌐 **API URL:** \`${baseApiUrl}\`\n📡 **Status:** Connected\n\n${baseApiUrl.includes('localhost') ? '🏠 Using Local API Server' : '☁️ Using Remote API Server'}`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, `❌ **API Test Failed**\n\nResponse: ${JSON.stringify(response.data)}`, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        bot.sendMessage(chatId, `❌ **API Connection Failed**\n\n**URL:** \`${baseApiUrl}\`\n**Error:** ${error.message}\n\n**Solutions:**\n1. Check if Docker container is running\n2. Verify the correct IP/port in .env\n3. Check firewall settings`, { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/gdrive_status/, async (msg) => {
    const chatId = msg.chat.id;
    const tokens = getGoogleToken(chatId);

    if (!tokens) {
        return bot.sendMessage(chatId, "❌ **Not Connected**\n\nUse /gdrive to connect your Google Drive account.", { parse_mode: 'Markdown' });
    }

    // Check API configuration
    const isLocalAPI = baseApiUrl.includes('localhost') || baseApiUrl.includes('127.0.0.1') || !baseApiUrl.includes('api.telegram.org');

    const statusText = `✅ **Google Drive Status**\n\n🔗 **Connection:** Connected\n🌐 **API Mode:** ${isLocalAPI ? 'Local Server' : 'Cloud API'}\n📡 **API URL:** \`${baseApiUrl}\`\n\n${isLocalAPI ? '✅ Large files supported (up to 2GB)' : '⚠️ Large files limited (20MB max)'}\n\n**Tips:**\n- For files >20MB, ensure you're using a Local Telegram Bot API server\n- If you get "file not found" errors, try re-uploading the file directly to this bot`;

    bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
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
    let fileSize = 0;

    if (reply.document) {
        fileId = reply.document.file_id;
        fileName = reply.document.file_name;
        fileSize = reply.document.file_size;
    }
    else if (reply.video) {
        fileId = reply.video.file_id;
        fileName = reply.video.file_name || 'video.mp4';
        fileSize = reply.video.file_size;
    }
    else if (reply.audio) {
        fileId = reply.audio.file_id;
        fileName = reply.audio.file_name || 'audio.mp3';
        fileSize = reply.audio.file_size;
    }
    else if (reply.photo && reply.photo.length > 0) {
        const photo = reply.photo[reply.photo.length - 1];
        fileId = photo.file_id;
        fileName = 'photo.jpg';
        fileSize = photo.file_size;
    }

    if (!fileId) return bot.sendMessage(chatId, "❌ No file found.");

    // Pre-check file size for better error messages
    const fileSizeMB = fileSize ? (fileSize / (1024 * 1024)).toFixed(2) : 'Unknown';
    console.log(`[GDrive] Processing file: ${fileName} (${fileSizeMB} MB)`);

    // Detect potentially old file IDs
    const fileIdTimestamp = extractTimestampFromFileId(fileId);
    const currentTime = Math.floor(Date.now() / 1000);
    const fileAge = currentTime - fileIdTimestamp;

    if (fileAge > 3600) { // Older than 1 hour
        const ageHours = Math.floor(fileAge / 3600);
        console.log(`[GDrive] Warning: File ID is ${ageHours} hours old - may not be available in local API`);
        bot.sendMessage(chatId, `⚠️ **Old File Detected**\n\nThis file was uploaded ${ageHours} hours ago and may not be available on the local server.\n\nIf upload fails, please re-upload the file directly to this bot.`, { parse_mode: 'Markdown' });
    }

    // Warn about large files upfront
    if (fileSize > 50 * 1024 * 1024) { // 50MB
        bot.sendMessage(chatId, `⚠️ **Large File Detected** (${fileSizeMB} MB)\n\nThis may take longer to process. If you encounter errors, try re-uploading the file directly to this bot.`, { parse_mode: 'Markdown' });
    }

    let lastUpdateListener = 0;
    let statusMsg = await bot.sendMessage(chatId, "⏳ *Downloading from Telegram...*", { parse_mode: 'Markdown' });
    let filePath = null;

    try {
        // 1. Get File Info (With Fallback)
        let file;
        console.log(`[GDrive] Fetching info for File ID: ${fileId} (Size: ${fileSizeMB} MB)`);

        // Check if we're using local or cloud API
        const isLocalAPI = baseApiUrl.includes('localhost') || baseApiUrl.includes('127.0.0.1') || !baseApiUrl.includes('api.telegram.org');
        console.log(`[GDrive] Using API: ${isLocalAPI ? 'Local' : 'Cloud'} (${baseApiUrl})`);

        try {
            file = await bot.getFile(fileId);
            console.log(`[GDrive] Successfully got file info via ${isLocalAPI ? 'Local' : 'Cloud'} API`);
        } catch (err) {
            console.error(`[GDrive] ${isLocalAPI ? 'Local' : 'Cloud'} API getFile failed for ${fileId}:`, err.message);

            // Only try cloud fallback if we were using local API
            if (isLocalAPI) {
                try {
                    console.log("[GDrive] Attempting Cloud API fallback...");
                    const cloudResp = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);

                    if (cloudResp.data && cloudResp.data.ok) {
                        file = cloudResp.data.result;
                        console.log("[GDrive] Cloud API fallback successful. Path:", file.file_path);
                    } else {
                        throw new Error(`Cloud API returned nok: ${JSON.stringify(cloudResp.data)}`);
                    }
                } catch (cloudErr) {
                    const cloudMsg = cloudErr.response ? JSON.stringify(cloudErr.response.data) : cloudErr.message;

                    // Detect specific "File too big" scenario
                    if (cloudMsg.includes("file is too big") || cloudMsg.includes("file is temporarily unavailable")) {
                        throw new Error(`⚠️ **File Upload Issue**\n\n**Problem:** This file is not available on the local server and is too large for cloud processing.\n\n**Solutions:**\n1. **Re-upload** the file directly to this bot\n2. **Forward** the file from another chat\n3. Use files smaller than 20MB for cloud processing\n4. Check if your local Telegram Bot API server is properly configured\n\n**Technical Details:**\n- Local API: ${err.message}\n- Cloud API: File too big (>20MB limit)`);
                    }

                    throw new Error(`❌ **File Access Failed**\n\n**Local API Error:** ${err.message}\n**Cloud API Error:** ${cloudMsg}\n\n**Solution:** Please re-upload or forward this file to the bot.`);
                }
            } else {
                // We were already using cloud API, so no fallback available
                throw new Error(`❌ **Cloud API Error:** ${err.message}\n\n**Solution:** Please re-upload the file or check if it's still available.`);
            }
        }
        const fileLink = file.file_path;
        filePath = path.join(downloadsDir, `${Date.now()}_${fileName}`);

        // Check if it's a URL or a Local Path (Local API returns absolute path starting with /)
        let resolvedLocalPath = resolveLocalFilePath(file.file_path);
        let downloadSuccess = false;

        // 1. Try Direct Path Copy first if it's a Local API
        if (resolvedLocalPath && fs.existsSync(resolvedLocalPath)) {
            bot.editMessageText("⬇️ *Copying from Local Server (Direct)...*", {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            }).catch(() => { });

            try {
                await new Promise((resolve, reject) => {
                    const r = fs.createReadStream(resolvedLocalPath);
                    const w = fs.createWriteStream(filePath);
                    r.pipe(w);
                    w.on('finish', () => { downloadSuccess = true; resolve(); });
                    w.on('error', reject);
                    r.on('error', reject);
                });
                console.log("[GDrive] Direct copy successful");
            } catch (e) {
                console.error("[GDrive] Direct copy failed:", e.message);
            }
        }

        // 2. HTTP Download (If Copy Failed or Not Local Path)
        if (!downloadSuccess) {
            const isLocalAPI = baseApiUrl.includes('localhost') || baseApiUrl.includes('127.0.0.1') || !baseApiUrl.includes('api.telegram.org');
            
            // Generate URL candidates
            const urls = [];
            const bases = [baseApiUrl];
            if (baseApiUrl.includes('localhost')) bases.push(baseApiUrl.replace('localhost', '127.0.0.1'));

            if (!isLocalAPI) {
                // Cloud API
                urls.push({ url: `https://api.telegram.org/file/bot${token}/${fileLink}`, desc: 'Telegram Cloud' });
            } else {
                // Local API - Intensive search
                let cleanRelative = fileLink;
                if (fileLink.startsWith('/')) cleanRelative = cleanRelative.substring(1);
                
                bases.forEach(base => {
                    const baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
                    urls.push({ url: `${baseUrl}/file/bot${token}/${cleanRelative}`, desc: 'Local Standard' });
                    urls.push({ url: `${baseUrl}/file/${token}/${cleanRelative}`, desc: 'Local No-Bot Prefix' });
                    urls.push({ url: `${baseUrl}/file/bot${token}/${cleanRelative}`, desc: 'Local Absolute' });
                    urls.push({ url: `${baseUrl}/${cleanRelative}`, desc: 'Local Direct' });
                });
            }

            // Try each URL
            for (const item of urls) {
                console.log(`[GDrive] Trying download: ${item.desc} (${item.url})`);
                try {
                    const writer = fs.createWriteStream(filePath);
                    const response = await axios({
                        url: item.url,
                        method: 'GET',
                        responseType: 'stream',
                        timeout: 10000 // 10s timeout to jump to next candidate if it hangs
                    });

                    const totalLength = parseInt(response.headers['content-length'] || (file ? file.file_size : 0), 10);
                    let downloadedLength = 0;

                    response.data.on('data', (chunk) => {
                        downloadedLength += chunk.length;
                        const now = Date.now();
                        if (now - lastUpdateListener > 3000) {
                            const percent = totalLength ? ((downloadedLength / totalLength) * 100).toFixed(1) : '0';
                            const mb = (downloadedLength / (1024 * 1024)).toFixed(2);
                            bot.editMessageText(`⬇️ *Downloading from ${item.desc}...*\n\n${generateProgressBar(percent)} ${percent}%\n${mb} MB`, {
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

                    downloadSuccess = true;
                    console.log(`[GDrive] Downloaded successfully from ${item.desc}`);
                    break; 

                } catch (e) {
                    console.log(`[GDrive] Download failed from ${item.desc}: ${e.message}`);
                    if (fs.existsSync(filePath)) {
                        try { fs.unlinkSync(filePath); } catch(err) {} 
                    }
                }
            }
        }

        if (!downloadSuccess) {
            throw new Error("Could not download file from any source. Please re-upload the file directly to the bot.");
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
                    // Use known fileSize if evt.total is unreliable
                    const total = evt.total || fileSize;
                    const loaded = evt.loaded;

                    const progress = total > 0 ? (loaded / total) * 100 : 0;
                    const loadedMB = (loaded / (1024 * 1024)).toFixed(2);
                    const totalMB = (total / (1024 * 1024)).toFixed(2);

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

        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => { });
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
        }).catch(() => { });
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
            }).catch(() => { });

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
bot.onText(/\/links/, async (msg) => {
    const chatId = msg.chat.id;

    bot.sendMessage(chatId, `📋 **Bulk Link Generator**\n\nForward or send multiple files to this chat, then use this command to generate direct links for all recent files.\n\n⏳ Scanning recent messages...`, { parse_mode: 'Markdown' });

    // Get recent messages with files
    // Note: This is a simplified version - in practice, you'd store file info in a database
    bot.sendMessage(chatId, `💡 **How to use:**\n\n1. Send/forward files to this chat\n2. Reply to each file with /fileLink\n3. Or use /fileLink on individual files\n\n🔄 **Coming Soon:** Bulk processing of multiple files at once!`, { parse_mode: 'Markdown' });
});

bot.onText(/\/check_credentials/, async (msg) => {
    const chatId = msg.chat.id;

    if (String(msg.from.id) !== String(ADMIN_ID)) {
        return bot.sendMessage(chatId, "❌ Admin only command");
    }

    let credInfo = `🔐 **API Credentials Check**\n\n`;

    // Check environment variables
    const apiId = process.env.TELEGRAM_API_ID;
    const apiHash = process.env.TELEGRAM_API_HASH;
    const botToken = process.env.BOT_TOKEN;

    credInfo += `🆔 **API ID:** ${apiId ? `${apiId.substring(0, 3)}***` : '❌ Not Set'}\n`;
    credInfo += `🔐 **API Hash:** ${apiHash ? `${apiHash.substring(0, 6)}***` : '❌ Not Set'}\n`;
    credInfo += `🤖 **Bot Token:** ${botToken ? `${botToken.substring(0, 10)}***` : '❌ Not Set'}\n`;
    credInfo += `🌐 **API URL:** ${baseApiUrl}\n\n`;

    // Check if running in Docker
    const isDocker = process.env.container || process.env.DOCKER_CONTAINER;
    credInfo += `🐳 **Docker:** ${isDocker ? 'Yes' : 'Unknown'}\n\n`;

    if (!apiId || !apiHash) {
        credInfo += `⚠️ **Missing Credentials!**\n\n`;
        credInfo += `Your Docker container needs API credentials.\n\n`;
        credInfo += `**To fix:**\n`;
        credInfo += `1. Stop container: \`docker stop telegram-bot-api\`\n`;
        credInfo += `2. Remove container: \`docker rm telegram-bot-api\`\n`;
        credInfo += `3. Start with credentials:\n`;
        credInfo += `\`docker run -d --name telegram-bot-api -p 8081:8081 -e TELEGRAM_API_ID=your_id -e TELEGRAM_API_HASH=your_hash aiogram/telegram-bot-api:latest --local\``;
    } else {
        credInfo += `✅ **Credentials Found**\n\n`;
        credInfo += `Your container has API credentials set.\n`;
        credInfo += `If files still don't work, the issue is likely:\n`;
        credInfo += `• Files not uploaded directly to bot\n`;
        credInfo += `• Missing --local flag\n`;
        credInfo += `• No persistent storage volume`;
    }

    bot.sendMessage(chatId, credInfo);
});

bot.onText(/\/diagnose/, async (msg) => {
    const chatId = msg.chat.id;

    let diagInfo = `🔍 **Bot Diagnosis Report**\n\n`;

    // Check API configuration
    const isLocal = baseApiUrl.includes('localhost') || baseApiUrl.includes('127.0.0.1');
    diagInfo += `🌐 **API Mode:** ${isLocal ? 'Local Server' : 'Cloud API'}\n`;
    diagInfo += `📡 **API URL:** ${baseApiUrl}\n`;

    // Check environment variables
    const hasApiId = process.env.TELEGRAM_API_ID ? 'Set' : 'Missing';
    const hasApiHash = process.env.TELEGRAM_API_HASH ? 'Set' : 'Missing';
    diagInfo += `🔑 **API ID:** ${hasApiId}\n`;
    diagInfo += `🔐 **API Hash:** ${hasApiHash}\n\n`;

    // Test API connection
    try {
        const botInfo = await bot.getMe();
        diagInfo += `✅ **Bot Connection:** Working\n`;
        diagInfo += `🤖 **Bot Name:** ${botInfo.first_name}\n`;
        diagInfo += `🆔 **Bot ID:** ${botInfo.id}\n\n`;
    } catch (e) {
        diagInfo += `❌ **Bot Connection:** Failed - ${e.message}\n\n`;
    }

    diagInfo += `📋 **Common Issues:**\n`;
    diagInfo += `• Files forwarded from other chats won't work\n`;
    diagInfo += `• Files uploaded before bot started won't work\n`;
    diagInfo += `• Bot session is separate from your personal session\n\n`;

    diagInfo += `💡 **Solutions:**\n`;
    diagInfo += `• Upload files directly to this bot\n`;
    diagInfo += `• Don't forward files from other chats\n`;
    diagInfo += `• Restart Docker with persistent storage\n`;
    diagInfo += `• Use /check_docker for Docker diagnosis`;

    bot.sendMessage(chatId, diagInfo);
});

bot.onText(/\/check_docker/, async (msg) => {
    const chatId = msg.chat.id;

    if (String(msg.from.id) !== String(ADMIN_ID)) {
        return bot.sendMessage(chatId, "❌ Admin only command");
    }

    bot.sendMessage(chatId, `🐳 **Docker Diagnosis**\n\nChecking your Docker setup...\n\nRun these commands on your server:\n\n\`docker ps | grep telegram-bot-api\`\n\`docker inspect telegram-bot-api | grep -A 5 "Mounts"\`\n\nThen share the output for analysis.`);
});

bot.onText(/\/test_upload/, async (msg) => {
    const chatId = msg.chat.id;

    bot.sendMessage(chatId, `🧪 **File Upload Test**\n\nTo test if your setup works:\n\n1. **Create a small test file** (like a .txt file)\n2. **Upload it directly** to this bot (don't forward)\n3. **Reply to it** with /link\n4. **Check if link works**\n\n📝 **What this tests:**\n• Bot can receive files\n• Local API server recognizes files\n• Link generation works\n• Docker setup is correct\n\n⚠️ **Important:** Don't forward files from other chats - upload fresh files only!`);
});

bot.onText(/\/link/, async (msg) => {
    const chatId = msg.chat.id;

    if (!msg.reply_to_message) {
        return bot.sendMessage(chatId, "⚠️ Reply to a file with /link to get its direct download link.");
    }

    const reply = msg.reply_to_message;
    let fileId, fileName, fileSize;

    if (reply.document) {
        fileId = reply.document.file_id;
        fileName = reply.document.file_name || 'document';
        fileSize = reply.document.file_size;
    }
    else if (reply.video) {
        fileId = reply.video.file_id;
        fileName = reply.video.file_name || 'video.mp4';
        fileSize = reply.video.file_size;
    }
    else if (reply.audio) {
        fileId = reply.audio.file_id;
        fileName = reply.audio.file_name || 'audio.mp3';
        fileSize = reply.audio.file_size;
    }
    else if (reply.photo && reply.photo.length > 0) {
        const photo = reply.photo[reply.photo.length - 1];
        fileId = photo.file_id;
        fileName = 'photo.jpg';
        fileSize = photo.file_size;
    }

    if (!fileId) {
        return bot.sendMessage(chatId, "❌ No supported file found.");
    }

    const fileSizeMB = fileSize ? (fileSize / (1024 * 1024)).toFixed(2) : 'Unknown';

    bot.sendMessage(chatId, `🔍 Generating link for ${fileName} (${fileSizeMB} MB)...`);

    try {
        // Use getFile instead of getFileLink for local API compatibility with large files
        const fileInfo = await bot.getFile(fileId);
        const internalFilePath = fileInfo.file_path;
        
        // Construct the internal link
        // We try the pattern that the server seems to prefer (no 'bot' prefix)
        const isLocalAPI = baseApiUrl.includes('localhost') || baseApiUrl.includes('127.0.0.1');
        
        // Try to construct a link that works with the local server's file serving
        let internalLink;
        if (isLocalAPI) {
            // Most local servers serve files at /file/<token>/<path>
            internalLink = `${baseApiUrl}/file/${token}/${internalFilePath}`;
        } else {
            internalLink = `https://api.telegram.org/file/bot${token}/${internalFilePath}`;
        }

        // Construct the public link
        const publicDomain = process.env.PUBLIC_DOWNLOAD_DOMAIN || baseApiUrl;
        const publicLink = internalLink.replace('http://localhost:8081', publicDomain);

        // Check if we can find it locally for better debug logs
        const resolvedPath = resolveLocalFilePath(internalFilePath);
        
        console.log(`[Link] SUCCESS: Generated link for ${fileName}`);
        if (resolvedPath) console.log(`[Link] Local Path Found: ${resolvedPath}`);
        console.log(`[Link] Intention: ${internalLink}`);
        console.log(`[Link] Public: ${publicLink}`);

        bot.sendMessage(chatId, `✅ Direct Download Link Generated:\n\n${publicLink}\n\nFile: ${fileName}\nSize: ${fileSizeMB} MB\n\nClick the button below or copy the link to download!`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📥 Download Now", url: publicLink }]
                ]
            }
        });

    } catch (error) {
        console.log(`[Link] Error for ${fileId}: ${error.message}`);

        if (error.message.includes('file_id') || error.message.includes('unavailable')) {
            bot.sendMessage(chatId, `❌ File not accessible\n\nFile: ${fileName}\nSize: ${fileSizeMB} MB\n\nSolution: Re-upload this file directly to the bot, then try /link again.`);
        } else if (error.message.includes('too big')) {
            bot.sendMessage(chatId, `❌ File too large\n\nFile: ${fileName}\nSize: ${fileSizeMB} MB\n\nThis file exceeds the API limits. Try using a smaller file or check your server configuration.`);
        } else {
            bot.sendMessage(chatId, `❌ Link generation failed\n\nError: ${error.message}\n\nTry re-uploading the file directly to this bot.`);
        }
    }
});

// Keep the old command for compatibility
bot.onText(/\/fileLink/, async (msg) => {
    bot.sendMessage(msg.chat.id, "🔄 Use /link instead (shorter and more reliable)\n\nReply to a file with /link to get its direct download link.");
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
