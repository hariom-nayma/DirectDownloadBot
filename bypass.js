const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function bypassUrl(url) {
    console.log(`[Bypass] Starting bypass for: ${url}`);
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Use networkidle2 to wait for initial stability, but don't fail if timeout
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            console.log("[Bypass] Initial navigation timeout (continuing anyway)...");
        }

        let finalLink = null;
        let attempts = 0;
        const maxAttempts = 50; // Increased for multi-step

        while (attempts < maxAttempts && !finalLink) {
            attempts++;

            // Wait a moment for redirects/DOM methods to settle
            await new Promise(r => setTimeout(r, 2000));

            let currentUrl;
            try {
                currentUrl = page.url();
            } catch (e) {
                console.log("[Bypass] Error getting URL, retrying loop...");
                continue;
            }

            console.log(`[Bypass] Step ${attempts}: ${currentUrl}`);

            // 0. Check Destination
            if (currentUrl.includes('t.me') || currentUrl.includes('telegram.me') || currentUrl.includes('drive.google')) {
                finalLink = currentUrl;
                break;
            }

            // Safe Evaluate Wrapper
            const safeEvaluate = async (fn) => {
                try {
                    return await page.evaluate(fn);
                } catch (e) {
                    if (e.message.includes('Execution context was destroyed')) {
                        console.log("[Bypass] Navigation occurred during evaluate, skipping...");
                        return null;
                    }
                    throw e;
                }
            };

            // 1. Check for Generic "Get Link" (vplink style)
            const foundLink = await safeEvaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                const target = links.find(a =>
                    (a.innerText.toLowerCase().includes('get link') || a.innerText.toLowerCase().includes('get download link')) &&
                    (a.href.includes('telegram') || a.href.includes('t.me') || a.href.includes('drive'))
                );
                return target ? target.href : null;
            });

            if (foundLink) {
                finalLink = foundLink;
                break;
            }

            // --- Combined SharClub / Lksfy / 24jobalert Logic ---
            if (currentUrl.includes('24jobalert.com') || currentUrl.includes('sharclub.in') || currentUrl.includes('lksfy.com')) {
                console.log(`[Bypass] Processing: ${currentUrl}`);

                // 1. Force unhide the download link (standard rewarded ad bypass)
                await safeEvaluate(() => {
                    const box = document.getElementById('download-link');
                    if (box) box.style.display = 'block';

                    // Remove Ads/Overlays (from old Sharclub logic)
                    if (location.href.includes('sharclub.in')) {
                        const overlays = Array.from(document.querySelectorAll('div, section')).filter(el => {
                            const style = window.getComputedStyle(el);
                            return style.position === 'fixed' || style.position === 'absolute' || style.zIndex > 100;
                        });
                        overlays.forEach(el => el.remove());
                    }
                });

                // 2. Poll for interactions
                let foundRealLink = null;
                const pollStartTime = Date.now();
                while (Date.now() - pollStartTime < 300000) { // Increased to 300s for 4 steps

                    // A. Smart Button Clicking
                    const clicked = await safeEvaluate(() => {
                        const isVisible = (el) => el && el.offsetParent !== null;

                        // 1. Check Top Button (Priority 1: Verification/Continue)
                        const topBtn = document.getElementById('topButton');
                        if (isVisible(topBtn)) {
                            const text = (topBtn.innerText || '').trim();
                            // Valid: "Human Verification", "Continue"
                            // Invalid: labels, "Click On Ads"
                            const invalidTexts = ['Scroll Down', 'Link is Ready', 'Please Wait', 'Click On Ads'];
                            const isInvalid = invalidTexts.some(t => text.includes(t));

                            if (!isInvalid && (text.includes('Human') || text.includes('Continue'))) {
                                topBtn.click();
                                return `Top Button: ${text}`;
                            }
                        }

                        // 2. Check Bottom Button (Priority 2: Progression)
                        const bottomBtn = document.getElementById('bottomButton');
                        if (isVisible(bottomBtn)) {
                            const text = (bottomBtn.innerText || '').trim();
                            // Wait if generating
                            if (text.includes('Generating') || text.includes('Please Wait')) {
                                return `WAIT: Bottom Button says ${text}`;
                            }
                            // Valid Actions
                            if (text.includes('Get Link') || text.includes('Next') || text.includes('Click To Continue') || text.includes('Download')) {
                                bottomBtn.click();
                                return `Bottom Button: ${text}`;
                            }
                        }

                        // 3. Fallback: Check Top Button again
                        if (isVisible(topBtn)) {
                            const text = (topBtn.innerText || '').trim();
                            const invalidTexts = ['Scroll Down', 'Link is Ready', 'Please Wait', 'Click On Ads'];
                            if (!invalidTexts.some(t => text.includes(t))) {
                                topBtn.click();
                                return `Top Button (Fallback): ${text}`;
                            }
                        }

                        // 4. Check specific IDs
                        const btn6 = document.getElementById('btn6');
                        if (isVisible(btn6)) { btn6.click(); return 'btn6'; }

                        const startBtn = document.getElementById('startCountdownBtn');
                        if (isVisible(startBtn)) { startBtn.click(); return 'startCountdownBtn'; }

                        // 5. Generic Fallback: Search for ANY "Get Link" button if specific IDs fail
                         // 5. Generic Fallback (Case Insensitive)
                        // Useful for final Lksfy page where ID might differ
                        const allButtons = Array.from(document.querySelectorAll('button, a, div, span, input'));
                        const visibleButtons = allButtons.filter(el => {
                            // Relaxed visibility: checks cleaning logic
                            return el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
                        });
                        
                        const genericGetLink = visibleButtons.find(el => {
                            const t = (el.innerText || el.value || '').trim().toLowerCase();
                            // Strict on text to avoid clicking random paragraphs
                            return t === 'get link' || t === 'get download link' || t === 'download link' || t === 'get link ->';
                        });

                        if (genericGetLink) {
                            genericGetLink.click();
                            return `Generic Button: ${(genericGetLink.innerText || genericGetLink.value || '').trim()}`;
                        }

                        return null;
                    });

                    if (clicked) {
                        console.log(`[Bypass] Smart Action: ${clicked}`);
                        if (clicked.startsWith('WAIT')) {
                            // Do nothing, just wait
                            await new Promise(r => setTimeout(r, 2000));
                        } else {
                            // We clicked something
                            // Wait for navigation or countdown (Reduced to 5s for speed)
                            await new Promise(r => setTimeout(r, 5000));
                        }
                    }

                    // A2. Check for New Tabs (Popups) - CRITICAL for final link
                    const pages = await browser.pages();
                    if (pages.length > 2) { // 1 is about:blank, 2 is current page. So > 2 means new tab?
                        // Actually puppeteer usually has 1 page initially.
                        // Let's filter for relevant pages
                        const newPage = pages.find(p => {
                            const pUrl = p.url();
                            return pUrl !== 'about:blank' &&
                                !pUrl.includes('sharclub.in') &&
                                !pUrl.includes('lksfy.com') &&
                                !pUrl.includes('24jobalert.com') &&
                                !pUrl.includes('google') // ads
                        });
                        if (newPage) {
                            console.log(`[Bypass] Detected new tab with URL: ${newPage.url()}`);
                            foundRealLink = newPage.url();
                            break;
                        }
                    }

                    // B. Check for the link
                    const extractedLink = await safeEvaluate(() => {
                        const a = document.querySelector('#download-link a');
                        return a ? a.href : null;
                    });

                    if (extractedLink) {
                        if (extractedLink.includes('your-download-link')) {
                            // console.log('[Bypass] Found placeholder link. Waiting/Retrying...');
                            await new Promise(r => setTimeout(r, 2000));
                            continue;
                        }
                        console.log(`[Bypass] Found potential real link: ${extractedLink}`);
                        foundRealLink = extractedLink;
                        break;
                    }

                    // C. Check if we navigated away
                    const currentUrlNow = page.url();
                    if (!currentUrlNow.includes('24jobalert.com') && !currentUrlNow.includes('sharclub.in') && !currentUrlNow.includes('lksfy.com')) {
                        console.log(`[Bypass] Navigated to: ${currentUrlNow}`);
                        foundRealLink = currentUrlNow;
                        break;
                    }

                    await new Promise(r => setTimeout(r, 2000));
                }

                console.log(`[Bypass] Inner loop exited. FoundRealLink: ${foundRealLink}`);

                if (!foundRealLink) {
                    // One last check for placeholder error
                    const placeholder = await safeEvaluate(() => {
                        const a = document.querySelector('#download-link a');
                        return a ? a.href : null;
                    });
                    if (placeholder && placeholder.includes('your-download-link')) {
                        throw new Error("Bypass Failed: Site returned placeholder link 'your-download-link'.");
                    }
                } else {
                    finalLink = foundRealLink;
                    break;
                }
            }



            // --- Vplink Logic ---
            // Case A: #tp-snp2
            const tpSnp2 = await page.$('#tp-snp2');
            if (tpSnp2) {
                try {
                    console.log("[Vplink] Found #tp-snp2, scrolling and clicking...");
                    await safeEvaluate(() => {
                        const el = document.getElementById('tp-snp2');
                        if (el) { el.scrollIntoView(); el.click(); }
                    });
                    await waitForNavigation(page);
                    continue;
                } catch (e) { console.log("Click failed:", e.message); }
            }

            // Case B: #btn6
            const btn6 = await page.$('#btn6');
            if (btn6) {
                try {
                    console.log("[Vplink] Found #btn6, clicking...");
                    await safeEvaluate(() => document.getElementById('btn6').click());
                    await new Promise(r => setTimeout(r, 11000));
                    console.log("[Vplink] Clicking #btn7...");
                    await safeEvaluate(() => {
                        const btn = document.getElementById('btn7');
                        if (btn) btn.click();
                    });
                    await waitForNavigation(page);
                    continue;
                } catch (e) { console.log("Step 1 interaction failed:", e.message); }
            }

            // Case C: #startCountdownBtn
            const startBtn = await page.$('#startCountdownBtn');
            if (startBtn) {
                try {
                    console.log("[Vplink] Found #startCountdownBtn, clicking...");
                    await safeEvaluate(() => document.getElementById('startCountdownBtn').click());
                    await new Promise(r => setTimeout(r, 11000));
                    console.log("[Vplink] Clicking #cross-snp2...");
                    await safeEvaluate(() => {
                        const btn = document.getElementById('cross-snp2');
                        if (btn) btn.click();
                    });
                    await waitForNavigation(page);
                    continue;
                } catch (e) { console.log("Step 2 interaction failed:", e.message); }
            }
        }

        return finalLink;

    } catch (e) {
        console.error("Bypass Error:", e);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

async function waitForNavigation(page) {
    try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 });
    } catch (e) {
        // Ignore timeout
    }
}

module.exports = { bypassUrl };
