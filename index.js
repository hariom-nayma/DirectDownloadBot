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
const https = require('https');
const { getUser, updateUser, checkPlan } = require('./helpers');

// Admin ID from env
const ADMIN_ID = process.env.ADMIN_ID;

const activeJobs = {}; // Store { chatId: { controller, filePath, stream, pendingUrl, state, customName, customThumb } }

// Helper to get effective limits based on plan
function getPlanLimits(plan) {
    if (plan === 'free') return { max_gb: 1, bandwidth: 'Standard' };
    if (plan === 'basic') return { max_gb: 1, bandwidth: 'Standard' };
    if (plan === 'premium') return { max_gb: 2, bandwidth: 'High' };
    if (plan === 'vip') return { max_gb: 2, bandwidth: 'High' }; // VIP duration is longer
    return { max_gb: 1 };
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

bot.onText(/\/plan/, (msg) => {
    const chatId = msg.chat.id;
    const user = checkPlan(chatId);

    let expiryText = "Lifetime";
    if (user.expiry) {
        expiryText = new Date(user.expiry).toLocaleDateString();
    }

    const usageText = user.plan === 'free' ? `\nWeekly Usage: ${user.downloads_this_week}/3` : '';

    const text = `📋 *Your Plan: ${user.plan.toUpperCase()}*\nExpiry: ${expiryText}${usageText}\n\n*Available Plans:*\n\n` +
        `🥉 *Basic (₹79/mo)*\n✅ Unlimited Downloads\n✅ 1GB File Limit\n\n` +
        `🥈 *Premium (₹99/mo)*\n✅ Unlimited Downloads\n✅ 2GB File Limit\n✅ Custom Captions\n\n` +
        `🥇 *VIP (₹199/2mo)*\n✅ Unlimited Downloads\n✅ 2GB File Limit\n✅ Custom Captions\n✅ 3 Month Access`;

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
                ],
                [{ text: `Screenshots: ${user.screenshots !== false ? 'ON' : 'OFF'}`, callback_data: 'toggle_screenshots' }]
            ]
        }
    };
    bot.sendMessage(chatId, text, opts);
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

bot.on('callback_query', (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;
    const user = checkPlan(chatId);

    if (data === 'toggle_screenshots') {
        const newState = user.screenshots === false ? true : false; // Default true
        updateUser(chatId, { screenshots: newState });

        bot.answerCallbackQuery(callbackQuery.id, { text: `Screenshots ${newState ? 'ON' : 'OFF'}` });

    } else if (data === 'start_rename') {
        activeJobs[chatId].state = 'WAITING_RENAME';
        bot.editMessageText("✏️ *Send me the new filename:*", {
            chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown'
        });

    } else if (data === 'start_thumb') {
        activeJobs[chatId].state = 'WAITING_THUMB';
        bot.editMessageText("🖼️ *Send me a photo to use as cover:*", {
            chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown'
        });

    } else if (data === 'confirm_download') {
        const job = activeJobs[chatId];
        if (job && job.pendingUrl) {
            bot.deleteMessage(chatId, msg.message_id).catch(e => { });
            processDownload(chatId, job.pendingUrl, job.customName, job.customThumb);
        }

    } else if (data === 'cancel_process') {
        const job = activeJobs[chatId];
        if (job) {
            // Abort the operations
            if (job.controller) job.controller.abort();

            // Cleanup streams explicitly if needed
            if (job.stream) {
                try { job.stream.destroy(); } catch (e) { }
            }

            bot.editMessageText("❌ Process Cancelled by User.", {
                chat_id: chatId,
                message_id: msg.message_id
            }).catch(e => { });

            // Cleanup files
            if (job.filePath && fs.existsSync(job.filePath)) {
                try { fs.unlinkSync(job.filePath); } catch (e) { }
            }

            // Remove from active jobs
            delete activeJobs[chatId];
            bot.answerCallbackQuery(callbackQuery.id, { text: "Cancelled!" });
        } else {
            bot.answerCallbackQuery(callbackQuery.id, { text: "No active process to cancel." });
        }
        return; // Exit
    }

    bot.answerCallbackQuery(callbackQuery.id);
});

// --- main Logic ---

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Handle Rename State
    if (activeJobs[chatId] && activeJobs[chatId].state === 'WAITING_RENAME' && text && !text.startsWith('/')) {
        activeJobs[chatId].customName = text.trim();
        activeJobs[chatId].state = 'IDLE';
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
    if (msg.photo && activeJobs[chatId] && activeJobs[chatId].state === 'WAITING_THUMB') {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

        const thumbPath = path.join(downloadsDir, `custom_thumb_${chatId}.jpg`);
        const writer = fs.createWriteStream(thumbPath);

        try {
            const response = await axios({
                url: fileUrl,
                method: 'GET',
                responseType: 'stream'
            });
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            activeJobs[chatId].customThumb = thumbPath;
            activeJobs[chatId].state = 'IDLE';
            bot.sendMessage(chatId, "✅ Cover set!\n\nSelect action:", {
                reply_markup: {
                    inline_keyboard: [[
                        { text: "⬇️ Start Upload", callback_data: "confirm_download" },
                        { text: "❌ Cancel", callback_data: "cancel_process" }
                    ]]
                }
            });
        } catch (e) {
            bot.sendMessage(chatId, "Failed to download thumb.");
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
        if (!activeJobs[chatId]) bot.sendMessage(chatId, "Please send a valid HTTP/HTTPS URL.");
        return;
    }

    // Check Plan & Show Menu
    const user = checkPlan(chatId);

    // Setup Job Intent
    if (!activeJobs[chatId]) activeJobs[chatId] = {};
    activeJobs[chatId].pendingUrl = text;
    activeJobs[chatId].state = 'IDLE';

    // Free Plan -> Auto Start
    if (user.plan === 'free') {
        processDownload(chatId, text);
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

    if (user.plan === 'free' && user.downloads_this_week >= 3) {
        bot.sendMessage(chatId, "⚠️ *Weekly Limit Reached* (3/3)\n\nUpgrade to /plan for Unlimited Downloads!", { parse_mode: 'Markdown' });
        return;
    }

    let statusMsg = await bot.sendMessage(chatId, "Initializing download...");
    let statusMsgId = statusMsg.message_id;
    let lastUpdate = Date.now();

    let filePath = null;

    try {
        const controller = new AbortController();
        // Update existing job or create new if immediate
        if (!activeJobs[chatId]) activeJobs[chatId] = {};

        activeJobs[chatId].controller = controller;
        activeJobs[chatId].filePath = null;

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
        if (activeJobs[chatId]) activeJobs[chatId].filePath = filePath;

        const writer = fs.createWriteStream(filePath);

        const totalLength = response.headers['content-length'];

        // CHECK SIZE LIMIT
        if (totalLength) {
            const fileSizeGB = totalLength / (1024 * 1024 * 1024);
            if (fileSizeGB > limits.max_gb) {
                throw new Error(`File too large (${fileSizeGB.toFixed(2)} GB).\nYour Plan Limit: ${limits.max_gb} GB.\nUpgrade: /plan`);
            }
        }

        // Increment usage if passed checks
        updateUser(chatId, { downloads_this_week: user.downloads_this_week + 1 });

        let downloadedLength = 0;
        let startTime = Date.now();

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
                    reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cancel_process" }]] }
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
                            thumbPath = path.join(downloadsDir, 'cover-thumb.jpg');
                            fluentFfmpeg(filePath)
                                .on('end', () => resolve())
                                .on('error', () => resolve()) // Ignore error
                                .screenshots({
                                    count: 1,
                                    folder: downloadsDir,
                                    filename: 'cover-thumb.jpg',
                                    timemarks: ['10%'], // Take from 10% point
                                    size: '320x240'
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
                            const filename = `thumb-${percent}.jpg`;

                            fluentFfmpeg()
                                .input(filePath)
                                .inputOptions([`-ss ${timestamp}`]) // Input seeking (FAST)
                                .output(path.join(downloadsDir, filename))
                                .frames(1)
                                .size('320x240')
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

                    const files = fs.readdirSync(downloadsDir).filter(f => f.startsWith('thumb-'));
                    // Sort by number to keep order
                    files.sort((a, b) => {
                        const nA = parseInt(a.match(/\d+/)[0]);
                        const nB = parseInt(b.match(/\d+/)[0]);
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
                    reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cancel_process" }]] }
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
        // node-telegram-bot-api accepts a stream
        const fileStream = fs.createReadStream(filePath).pipe(str);
        if (activeJobs[chatId]) activeJobs[chatId].stream = fileStream;

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

            await bot.sendVideo(chatId, fileStream, opts, { filename: fileName });
        } else {
            const opts = {
                caption: caption
            };
            await bot.sendDocument(chatId, fileStream, opts, { filename: fileName });
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
        if (axios.isCancel(error)) return;

        console.error("Error processing link:", error.message);
        let errorMessage = error.message;
        if (error.code === 'ETIMEDOUT') errorMessage = "Connection timed out.";
        bot.sendMessage(chatId, `Failed: ${errorMessage}`);
        // Cleanup if needed
        if (filePath && fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) { }
        }
    } finally {
        delete activeJobs[chatId];
    }
}

console.log("Bot is running...");
