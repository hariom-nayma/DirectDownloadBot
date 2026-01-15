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
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        let finalLink = null;
        let attempts = 0;
        const maxAttempts = 20;

        while (attempts < maxAttempts && !finalLink) {
            attempts++;
            const currentUrl = page.url();
            console.log(`[Bypass] Step ${attempts}: ${currentUrl}`);

            // 0. Check if we are already at a Telegram link or similar final destination
            if (currentUrl.includes('t.me') || currentUrl.includes('telegram.me')) {
                finalLink = currentUrl;
                break;
            }

            // check for "Get Link" anchor which might be the final step on vplink page
            const foundLink = await page.evaluate(() => {
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
            // Often "Scroll down to continue"
            const tpSnp2 = await page.$('#tp-snp2');
            if (tpSnp2) {
                console.log("Found #tp-snp2, scrolling and clicking...");
                await page.evaluate(() => {
                    const el = document.getElementById('tp-snp2');
                    el.scrollIntoView();
                    el.click();
                });
                await waitForNavigation(page);
                continue;
            }

            // Case B: #btn6 (Verify - Step 1/3)
            const btn6 = await page.$('#btn6');
            if (btn6) {
                console.log("Found #btn6 (Verify), clicking...");
                await page.evaluate(() => document.getElementById('btn6').click());
                
                // Wait for timer
                console.log("Waiting for countdown...");
                await new Promise(r => setTimeout(r, 11000));

                // Click #btn7 (Continue)
                const btn7 = await page.$('#btn7');
                if (btn7) {
                    console.log("Found #btn7 (Continue), clicking...");
                    await page.evaluate(() => document.getElementById('btn7').click());
                    await waitForNavigation(page);
                    continue;
                }
            }

            // Case C: #startCountdownBtn (Verify - Step 2/3)
            const startBtn = await page.$('#startCountdownBtn');
            if (startBtn) {
                console.log("Found #startCountdownBtn, clicking...");
                await page.evaluate(() => document.getElementById('startCountdownBtn').click());
                
                // Wait for timer
                console.log("Waiting for countdown...");
                await new Promise(r => setTimeout(r, 11000));

                // Click #cross-snp2 (Continue)
                const crossSnp2 = await page.$('#cross-snp2');
                if (crossSnp2) {
                    console.log("Found #cross-snp2 (Continue), clicking...");
                    await page.evaluate(() => document.getElementById('cross-snp2').click());
                    await waitForNavigation(page);
                    continue;
                }
            }
            
            // Case D: Generic "Get Link" button that does not have specific HREF yet (maybe needs click to generate)
            // Looking for generic buttons if specific ones fail?
            // For now, let's rely on the specific IDs found in inspection.
            
            // If stuck, wait a bit and retry loop (maybe page load specific script)
            await new Promise(r => setTimeout(r, 2000));
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
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
        console.log("Navigation timeout or already loaded.");
    }
}

module.exports = { bypassVplink };
