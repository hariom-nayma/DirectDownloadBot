const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'database.json');

// Initialize DB if not exists
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2));
}

let dbCache = null;

function loadDB() {
    if (dbCache) return dbCache;
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        dbCache = JSON.parse(data);
    } catch (e) {
        console.error("DB Load Error:", e);
        dbCache = { users: {} };
    }
    return dbCache;
}

function saveDB() {
    if (!dbCache) return;
    try {
        // Write atomically-ish (sync is fine for low traffic)
        fs.writeFileSync(DB_FILE, JSON.stringify(dbCache, null, 2));
    } catch (e) {
        console.error("DB Save Error:", e);
    }
}

function getUser(userId) {
    const db = loadDB();
    const strId = String(userId);
    if (!db.users[strId]) {
        db.users[strId] = {
            plan: 'free',
            expiry: null,
            downloads_this_week: 0,
            week_start: Date.now()
        };
        saveDB();
    }
    return db.users[strId];
}

function updateUser(userId, updates) {
    const db = loadDB();
    const strId = String(userId);
    if (!db.users[strId]) getUser(userId); // ensure exists

    Object.assign(db.users[strId], updates);
    saveDB();
    return db.users[strId];
}

function checkPlan(userId) {
    // Returns current effective plan (checks expiry)
    let user = getUser(userId);

    // Check Expiry
    if (user.plan !== 'free' && user.expiry) {
        if (Date.now() > user.expiry) {
            // Expired
            user = updateUser(userId, { plan: 'free', expiry: null });
        }
    }

    // Check Week Reset
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - user.week_start > ONE_WEEK) {
        user = updateUser(userId, {
            week_start: Date.now(),
            downloads_this_week: 0
        });
    }

    return user;
}

module.exports = {
    getUser,
    updateUser,
    checkPlan
};
