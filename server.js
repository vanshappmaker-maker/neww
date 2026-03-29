// ============================================
// PUSH NOTIFY PRO - Backend Server
// ============================================
// This server handles sending push notifications
// via Firebase Cloud Messaging (FCM)
// ============================================

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');

// Initialize users file if it doesn't exist
if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([]));
}

function getUsers() {
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE));
    } catch (e) {
        return [];
    }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ---- Middleware ----
app.use(cors());
app.use(express.json());

// Serve admin panel static files at /admin
app.use('/admin', express.static(path.join(__dirname, '..', 'admin-panel')));

// Serve user web app static files at /user
app.use('/user', express.static(path.join(__dirname, '..', 'user-web-app')));

// Serve Firebase service worker at root scope (required for FCM)
app.get('/firebase-messaging-sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'user-web-app', 'firebase-messaging-sw.js'));
});

// ============================================
// FIREBASE INITIALIZATION
// ============================================
// IMPORTANT: Place your Firebase service account key JSON file
// in the backend folder and name it: serviceAccountKey.json
// Download it from: Firebase Console > Project Settings > Service Accounts > Generate New Private Key

try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase Admin SDK initialized successfully');
} catch (error) {
    console.error('⚠️  Firebase Admin SDK initialization failed!');
    console.error('   Make sure serviceAccountKey.json is in the backend folder.');
    console.error('   The server will start but sending notifications will fail.');
    console.error('   Error:', error.message);

    // Initialize with default (will fail when sending, but server starts)
    try {
        admin.initializeApp();
    } catch (e) {
        // Already initialized or no credentials
    }
}

// ============================================
// API ROUTES
// ============================================

// ---- User Registration ----
app.post('/api/users/register', (req, res) => {
    try {
        const { email, name, token, device, topics } = req.body;
        if (!email || !token) {
            return res.status(400).json({ error: 'Email and token are required' });
        }

        let users = getUsers();
        const existingIndex = users.findIndex(u => u.email === email);

        const userData = {
            email,
            name: name || email.split('@')[0],
            token,
            device: device || 'Web',
            topics: topics || ['all', 'general'],
            lastActive: new Date().toISOString()
        };

        if (existingIndex > -1) {
            // Update existing user
            users[existingIndex] = { ...users[existingIndex], ...userData };
        } else {
            // Add new user
            users.push(userData);
        }

        saveUsers(users);
        res.json({ success: true, user: userData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---- Get All Users ----
app.get('/api/users', (req, res) => {
    res.json(getUsers());
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        firebase: admin.apps.length > 0 ? 'connected' : 'disconnected'
    });
});

// ---- Send Notification ----
app.post('/api/send', async (req, res) => {
    try {
        const { targetType, targetValue, title, body, image, clickAction, icon, priority, data } = req.body;

        if (!title || !body) {
            return res.status(400).json({ error: 'Title and body are required' });
        }

        console.log(`📤 Sending notification: "${title}" to ${targetType}:${targetValue || 'all'}`);

        // Build message - keep it simple and reliable
        let message = {
            notification: {
                title: String(title),
                body: String(body),
            },
            data: {
                title: String(title),
                body: String(body),
                click_action: String(clickAction || '/'),
            },
        };

        // Add image if provided
        if (image) {
            message.notification.imageUrl = String(image);
            message.data.image = String(image);
        }

        let result;

        switch (targetType) {
            case 'token':
                if (!targetValue) {
                    return res.status(400).json({ error: 'Device token is required' });
                }
                message.token = targetValue;
                result = await admin.messaging().send(message);
                break;

            case 'topic':
                if (!targetValue) {
                    return res.status(400).json({ error: 'Topic name is required' });
                }
                message.topic = targetValue;
                result = await admin.messaging().send(message);
                break;

            case 'all':
                message.topic = 'all';
                result = await admin.messaging().send(message);
                break;

            default:
                return res.status(400).json({ error: 'Invalid target type' });
        }

        console.log(`✅ Notification sent successfully: ${result}`);
        res.json({
            success: true,
            messageId: result,
            target: targetType === 'all' ? 'all users' : targetValue,
        });

    } catch (error) {
        console.error('❌ Send notification error:', error.code, error.message);
        res.status(500).json({
            error: error.message,
            code: error.code,
        });
    }
});

// ---- Quick Test Push (for debugging) ----
app.get('/api/test-push/:token', async (req, res) => {
    try {
        const token = req.params.token;
        console.log('🧪 Test push to token:', token.substring(0, 20) + '...');

        const message = {
            notification: {
                title: '🔔 Push Test Successful!',
                body: 'If you see this, push notifications are working!',
            },
            token: token,
        };

        const result = await admin.messaging().send(message);
        console.log('✅ Test push sent:', result);
        res.json({ success: true, messageId: result });
    } catch (error) {
        console.error('❌ Test push failed:', error.code, error.message);
        res.json({ success: false, error: error.message, code: error.code });
    }
});

// ---- Send to Multiple Tokens ----
app.post('/api/send-multicast', async (req, res) => {
    try {
        const { tokens, title, body, image, data } = req.body;

        if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
            return res.status(400).json({ error: 'Token array is required' });
        }

        const message = {
            notification: { title, body },
            tokens,
        };

        if (image) message.notification.imageUrl = image;
        if (data) message.data = data;

        const result = await admin.messaging().sendEachForMulticast(message);

        console.log(`✅ Multicast: ${result.successCount} success, ${result.failureCount} failures`);
        res.json({
            success: true,
            successCount: result.successCount,
            failureCount: result.failureCount,
        });

    } catch (error) {
        console.error('❌ Multicast error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---- Subscribe to Topic ----
app.post('/api/topics/subscribe', async (req, res) => {
    try {
        const { tokens, topic } = req.body;

        if (!tokens || !topic) {
            return res.status(400).json({ error: 'Tokens and topic are required' });
        }

        const result = await admin.messaging().subscribeToTopic(tokens, topic);
        res.json({
            success: true,
            successCount: result.successCount,
            failureCount: result.failureCount,
        });

    } catch (error) {
        console.error('❌ Subscribe error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---- Unsubscribe from Topic ----
app.post('/api/topics/unsubscribe', async (req, res) => {
    try {
        const { tokens, topic } = req.body;

        if (!tokens || !topic) {
            return res.status(400).json({ error: 'Tokens and topic are required' });
        }

        const result = await admin.messaging().unsubscribeFromTopic(tokens, topic);
        res.json({
            success: true,
            successCount: result.successCount,
            failureCount: result.failureCount,
        });

    } catch (error) {
        console.error('❌ Unsubscribe error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---- Serve Pages ----
app.get('/', (req, res) => {
    res.redirect('/admin');
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'admin-panel', 'index.html'));
});

app.get('/user', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'user-web-app', 'index.html'));
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log('');
    console.log('🚀 ===================================');
    console.log('   PUSH NOTIFY PRO - Backend Server');
    console.log('   ===================================');
    console.log(`   🌐 Server:  http://localhost:${PORT}`);
    console.log(`   📊 Admin:   http://localhost:${PORT}/admin`);
    console.log(`   👤 User:    http://localhost:${PORT}/user`);
    console.log(`   💚 Health:  http://localhost:${PORT}/api/health`);
    console.log('   ===================================');
    console.log('');
});
