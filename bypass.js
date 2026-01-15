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

            // --- Lksfy / SharClub Logic (4 Steps) ---
            if (currentUrl.includes('sharclub.in')) {
                // Remove Ads
                await safeEvaluate(() => {
                    const overlays = Array.from(document.querySelectorAll('div, section')).filter(el => {
                        const style = window.getComputedStyle(el);
                        return style.position === 'fixed' || style.position === 'absolute' || style.zIndex > 100;
                    });
                    overlays.forEach(el => el.remove());
                    const iframes = document.querySelectorAll('iframe');
                    iframes.forEach(el => el.remove());

                    // Try to ensure body is scrollable
                    document.body.style.overflow = 'auto';
                });

                // Step A: Click Top Button (Human Verification)
                const topBtn = await page.$('#topButton');
                if (topBtn) {
                    try {
                        const btnText = await safeEvaluate(() => document.getElementById('topButton').innerText);
                        console.log(`[SharClub] Top Button Text: ${btnText}`);

                        if (btnText.includes('Human Verification') || btnText.includes('Human Veification')) {
                            console.log("[SharClub] Clicking Human Verification...");
                            await safeEvaluate(() => document.getElementById('topButton').click());
                            // Wait 15s
                            await new Promise(r => setTimeout(r, 16000));
                        } else if (btnText.includes('Continue') || btnText.includes('Click On Ads')) {
                            // Relaxed check: "Click On Ads To Get Download Button" OR "Click On Ads To Get Download Link"
                            console.log("[SharClub] Clicking Continue (Phase 1)...");
                            await safeEvaluate(() => document.getElementById('topButton').click());

                            // Now we need to scroll down and find bottomButton
                            await new Promise(r => setTimeout(r, 2000));
                        } else if (btnText.includes('Scroll Down Link is Ready')) {
                            // This is just a label, ignore and check bottom
                            console.log("[SharClub] Top says ready, checking bottom...");
                        }
                    } catch (e) { console.log("Top Button Error:", e.message); }
                }

                // Step B: Click Bottom Button (Generate Link)
                const bottomBtn = await page.$('#bottomButton');
                if (bottomBtn) {
                    try {
                        // Scroll to bottom
                        await safeEvaluate(() => window.scrollTo(0, document.body.scrollHeight));

                        const btnText = await safeEvaluate(() => document.getElementById('bottomButton').innerText);
                        console.log(`[SharClub] Bottom Button Text: ${btnText}`);

                        if (btnText.includes('Generating Link')) {
                            console.log("[SharClub] Clicking Generating Link...");
                            await safeEvaluate(() => document.getElementById('bottomButton').click());
                            // Wait 8s
                            await new Promise(r => setTimeout(r, 9000));
                        } else if (btnText.includes('Next') || btnText.includes('Get Link') || btnText.includes('Click To Continue')) {
                            console.log("[SharClub] Clicking Next/Get Link/Continue...");
                            await safeEvaluate(() => {
                                const btn = document.getElementById('bottomButton');
                                if (btn) {
                                    btn.click();
                                    // Sometimes it opens a new tab, we want to stay
                                }
                            });
                            await waitForNavigation(page);
                            continue;
                        }
                    } catch (e) { console.log("Bottom Button Error:", e.message); }
                }
            }
            // --- End Lksfy Logic ---

            // --- 24jobalert.com Logic ---
            if (currentUrl.includes('24jobalert.com')) {
                console.log("[24jobalert] Detected. Handling with minimal interference...");
                
                // 1. Initial cleanup (minimal)
                await safeEvaluate(() => {
                     // Only remove the big modal, leave iframes alone as they might control timer
                    const model = document.getElementById('AdbModel');
                    if (model) model.remove();
                    const backdrop = document.querySelector('.modal-backdrop');
                    if (backdrop) backdrop.remove();
                    document.body.style.overflow = 'auto';
                    
                    // Make sure link container is visible
                    const dl = document.getElementById('download-link');
                    if (dl) {
                        dl.style.display = 'block';
                        dl.style.visibility = 'visible';
                    }
                });

                // 2. Loop to find link or interact
                let foundRealLink = null;
                const pollStartTime = Date.now();
                
                while (Date.now() - pollStartTime < 45000) { // 45s timeout
                    
                    // A. Check for New Tabs (Popups)
                    // Sometimes the destination opens in a new tab
                    // Logic for 24jobalert main loop

                    const extractedLink = await page.evaluate(() => {
                        const a = document.querySelector('#download-link a');
                        return a ? a.href : null;
                    });

                    if (extractedLink) {
                        if (extractedLink.includes('your-download-link')) {
                            console.log('[24jobalert] Found placeholder link. Waiting/Retrying...');
                            // Provide a chance for it to change (unlikely based on analysis, but safe)
                            await new Promise(r => setTimeout(r, 2000));
                            continue;
                        }
                        console.log(`[24jobalert] Found potential real link: ${extractedLink}`);
                        foundRealLink = extractedLink;
                        break;
                    }

                    // Check if we navigated away (unlikely if we didn't click)
                    const currentUrlNow = page.url();
                    if (!currentUrlNow.includes('24jobalert.com')) {
                        try {
                            await safeEvaluate(() => {
                                // Close buttons
                                const closeBtns = document.querySelectorAll('.close-btn, .close, button.close, [aria-label="Close"]');
                                closeBtns.forEach(b => b.click());
                                
                                // "Click to generate" type buttons?
                                // Only click if it's NOT the your-download-link anchor (unless we are desperate?)
                                // Let's avoid clicking the placeholder for now, rely on script/timer.
                                // But if 20s pass and nothing, maybe click it.
                            });
                        } catch(e) {}
                    }
                    
                    // F. Click placeholder as last resort (after 10s)
                    if (Date.now() - pollStartTime > 10000 && (Date.now() - pollStartTime) % 5000 < 500) {
                         console.log("[24jobalert] Trying to click placeholder link...");
                         await safeEvaluate(() => {
                             const dl = document.getElementById('download-link');
                             if (dl) {
                                 const a = dl.querySelector('a');
                                 if (a) a.click();
                             }
                         });
                    }

                    await new Promise(r => setTimeout(r, 1000));
                }

                if (foundRealLink) {
                    finalLink = foundRealLink;
                    break;
                } else {
                    console.log("[24jobalert] Timeout.");
                    // Fallback to whatever URL we are on? No.
                    await new Promise(r => setTimeout(r, 2000));
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
