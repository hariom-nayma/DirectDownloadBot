const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function bypassVplink(url) {
    console.log(`[Bypass] Starting bypass for: ${url}`);
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        
        // Optimize: Block resources to speed up
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
        const maxAttempts = 30; // Increased attempts

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

            // 0. Check if we are already at a Telegram link or similar final destination
            if (currentUrl.includes('t.me') || currentUrl.includes('telegram.me')) {
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

            // check for "Get Link" anchor which might be the final step on vplink page
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

            // Identify Page Type and Actions

            // Case A: #tp-snp2 (Generic "Continue" on blogs)
            const tpSnp2 = await page.$('#tp-snp2');
            if (tpSnp2) {
                try {
                    console.log("Found #tp-snp2, scrolling and clicking...");
                    await safeEvaluate(() => {
                        const el = document.getElementById('tp-snp2');
                        if(el) { el.scrollIntoView(); el.click(); }
                    });
                    await waitForNavigation(page);
                    continue;
                } catch(e) { console.log("Click failed:", e.message); }
            }

            // Case B: #btn6 (Verify - Step 1/3)
            const btn6 = await page.$('#btn6');
            if (btn6) {
                try {
                    console.log("Found #btn6 (Verify), clicking...");
                    await safeEvaluate(() => document.getElementById('btn6').click());
                    
                    // Wait for timer
                    console.log("Waiting for countdown...");
                    await new Promise(r => setTimeout(r, 11000));

                    // Click #btn7 (Continue)
                    console.log("Attempting check for #btn7...");
                    await safeEvaluate(() => {
                         const btn = document.getElementById('btn7');
                         if(btn) btn.click();
                    });
                    await waitForNavigation(page);
                    continue;
                } catch (e) { console.log("Step 1 interaction failed:", e.message); }
            }

            // Case C: #startCountdownBtn (Verify - Step 2/3)
            const startBtn = await page.$('#startCountdownBtn');
            if (startBtn) {
                try {
                    console.log("Found #startCountdownBtn, clicking...");
                    await safeEvaluate(() => document.getElementById('startCountdownBtn').click());
                    
                    // Wait for timer
                    console.log("Waiting for countdown...");
                    await new Promise(r => setTimeout(r, 11000));

                    // Click #cross-snp2 (Continue)
                    console.log("Attempting check for #cross-snp2...");
                    await safeEvaluate(() => {
                        const btn = document.getElementById('cross-snp2');
                        if(btn) btn.click();
                    });
                    await waitForNavigation(page);
                    continue;
                } catch (e) { console.log("Step 2 interaction failed:", e.message); }
            }
        
            // Fail safe wait
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
        // Ignore timeout, we just wait a bit
    }
}

module.exports = { bypassVplink };
