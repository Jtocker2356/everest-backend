// ============================================================================
// NotificationService.js - Phase 6
// Handles APNs push notifications for Everest Trading
// ============================================================================

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class NotificationService {
    constructor(pool) {
        this.pool = pool;

        // APNs config from environment variables
        this.teamId = process.env.APNS_TEAM_ID;
        this.keyId = process.env.APNS_KEY_ID;
        this.bundleId = process.env.APNS_BUNDLE_ID || 'com.yourcompany.TradePro';
        this.keyPath = process.env.APNS_KEY_PATH || './AuthKey.p8';
        this.isProduction = process.env.NODE_ENV === 'production';

        this.apnsHost = this.isProduction
            ? 'api.push.apple.com'
            : 'api.sandbox.push.apple.com';

        this.jwtToken = null;
        this.jwtExpiry = null;

        console.log('📱 NotificationService initialized');
        console.log(`   APNs host: ${this.apnsHost}`);
        console.log(`   Bundle ID: ${this.bundleId}`);
    }

    // ============================================================================
    // JWT TOKEN MANAGEMENT
    // ============================================================================

    getJWTToken() {
        // Regenerate token every 50 minutes (Apple requires < 60 min)
        if (this.jwtToken && this.jwtExpiry && Date.now() < this.jwtExpiry) {
            return this.jwtToken;
        }

        try {
            const key = fs.readFileSync(this.keyPath);
            const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: this.keyId })).toString('base64url');
            const payload = Buffer.from(JSON.stringify({ iss: this.teamId, iat: Math.floor(Date.now() / 1000) })).toString('base64url');

            const sign = crypto.createSign('SHA256');
            sign.update(`${header}.${payload}`);
            const signature = sign.sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url');

            this.jwtToken = `${header}.${payload}.${signature}`;
            this.jwtExpiry = Date.now() + (50 * 60 * 1000);
            return this.jwtToken;
        } catch (error) {
            console.error('❌ Failed to generate APNs JWT:', error.message);
            return null;
        }
    }

    // ============================================================================
    // SEND SINGLE NOTIFICATION
    // ============================================================================

    async sendToDevice(token, title, body, data = {}) {
        const jwt = this.getJWTToken();
        if (!jwt) {
            console.error('❌ No APNs JWT token available');
            return { success: false, error: 'No JWT token' };
        }

        const payload = JSON.stringify({
            aps: {
                alert: { title, body },
                sound: 'default',
                badge: 1,
                'content-available': 1
            },
            ...data
        });

        return new Promise((resolve) => {
            const options = {
                hostname: this.apnsHost,
                port: 443,
                path: `/3/device/${token}`,
                method: 'POST',
                headers: {
                    'authorization': `bearer ${jwt}`,
                    'apns-topic': this.bundleId,
                    'apns-push-type': 'alert',
                    'apns-priority': '10',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload)
                }
            };

            const req = https.request(options, (res) => {
                let responseData = '';
                res.on('data', chunk => responseData += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve({ success: true, apnsId: res.headers['apns-id'] });
                    } else {
                        console.error(`❌ APNs error ${res.statusCode}:`, responseData);
                        // Remove invalid tokens
                        if (res.statusCode === 410 || res.statusCode === 400) {
                            this.removeInvalidToken(token);
                        }
                        resolve({ success: false, status: res.statusCode, error: responseData });
                    }
                });
            });

            req.on('error', (err) => {
                console.error('❌ APNs request error:', err.message);
                resolve({ success: false, error: err.message });
            });

            req.write(payload);
            req.end();
        });
    }

    // ============================================================================
    // SEND TO ALL USER DEVICES
    // ============================================================================

    async sendToUser(userId, title, body, data = {}, type = 'general') {
        try {
            // Get all device tokens for user
            const tokensResult = await this.pool.query(
                'SELECT token FROM device_tokens WHERE user_id = $1',
                [userId]
            );

            if (tokensResult.rows.length === 0) {
                return { success: false, error: 'No device tokens' };
            }

            // Send to all devices
            const results = await Promise.all(
                tokensResult.rows.map(row => this.sendToDevice(row.token, title, body, data))
            );

            // Log notification
            await this.pool.query(
                `INSERT INTO notification_log (user_id, type, title, body, data, status)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [userId, type, title, body, JSON.stringify(data),
                 results.some(r => r.success) ? 'sent' : 'failed']
            );

            const sent = results.filter(r => r.success).length;
            console.log(`📱 Notification sent to ${sent}/${results.length} devices for user ${userId}`);
            return { success: sent > 0, sent, total: results.length };
        } catch (error) {
            console.error('❌ sendToUser error:', error.message);
            return { success: false, error: error.message };
        }
    }

    // ============================================================================
    // NOTIFICATION TYPES
    // ============================================================================

    async notifyTradeOpened(userId, symbol, side, delayMinutes = 0) {
        // Check user preference
        const prefs = await this.getPreferences(userId);
        if (!prefs?.trade_opened) return;

        const title = `Trade Opened: ${symbol}`;
        const body = `Your ${side.toUpperCase()} position in ${symbol} is now open.`;
        const data = { type: 'trade_opened', symbol, side };

        if (delayMinutes > 0) {
            // Schedule for later
            await this.scheduleNotification(userId, 'trade_opened', title, body, data, delayMinutes);
        } else {
            await this.sendToUser(userId, title, body, data, 'trade_opened');
        }
    }

    async notifyTradeClosed(userId, symbol, side, profitLoss, profitLossPct) {
        const prefs = await this.getPreferences(userId);
        if (!prefs?.trade_closed) return;

        const isProfit = profitLoss >= 0;
        const emoji = isProfit ? '🟢' : '🔴';
        const title = `${emoji} Trade Closed: ${symbol}`;
        const pct = Math.abs(profitLossPct).toFixed(2);
        const body = isProfit
            ? `${symbol} closed +${pct}% profit`
            : `${symbol} closed -${pct}% loss`;

        const data = { type: 'trade_closed', symbol, side, profitLoss, profitLossPct };
        await this.sendToUser(userId, title, body, data, 'trade_closed');
    }

    async notifyNewFollower(userId, followerUsername) {
        const prefs = await this.getPreferences(userId);
        if (!prefs?.followers) return;

        const title = 'New Follower';
        const body = `@${followerUsername} started following you`;
        const data = { type: 'new_follower', followerUsername };
        await this.sendToUser(userId, title, body, data, 'new_follower');
    }

    // ============================================================================
    // WEEKLY PERFORMANCE SUMMARY
    // ============================================================================

    async sendWeeklySummaries() {
        console.log('📊 Sending weekly performance summaries...');
        try {
            // Get all users who want weekly summaries and have device tokens
            const users = await this.pool.query(`
                SELECT DISTINCT u.public_id, u.username
                FROM users u
                JOIN device_tokens dt ON dt.user_id = u.public_id
                JOIN notification_preferences np ON np.user_id = u.public_id
                WHERE np.weekly_summary = true
            `);

            console.log(`📊 Sending weekly summary to ${users.rows.length} users`);

            for (const user of users.rows) {
                await this.sendWeeklySummaryToUser(user.public_id);
                // Small delay between users to avoid APNs rate limits
                await new Promise(r => setTimeout(r, 100));
            }
        } catch (error) {
            console.error('❌ Weekly summary error:', error.message);
        }
    }

    async sendWeeklySummaryToUser(userId) {
        try {
            const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

            const stats = await this.pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status = 'closed') as closed_trades,
                    COUNT(*) FILTER (WHERE status = 'closed' AND profit_loss > 0) as winning_trades,
                    COALESCE(SUM(profit_loss) FILTER (WHERE status = 'closed'), 0) as total_pnl,
                    COALESCE(MAX(profit_loss_pct) FILTER (WHERE status = 'closed'), 0) as best_trade
                FROM trades
                WHERE user_id = (SELECT id FROM users WHERE public_id = $1)
                AND closed_at >= $2
            `, [userId, weekAgo]);

            const s = stats.rows[0];
            const closedTrades = parseInt(s.closed_trades) || 0;

            if (closedTrades === 0) return; // No trades this week, skip

            const winRate = closedTrades > 0
                ? ((parseInt(s.winning_trades) / closedTrades) * 100).toFixed(0)
                : 0;
            const totalPnl = parseFloat(s.total_pnl).toFixed(2);
            const isProfit = parseFloat(totalPnl) >= 0;

            const title = `📊 Your Weekly Trading Summary`;
            const body = `${closedTrades} trades • ${winRate}% win rate • ${isProfit ? '+' : ''}$${totalPnl} P&L`;

            await this.sendToUser(userId, title, body,
                { type: 'weekly_summary', closedTrades, winRate, totalPnl },
                'weekly_summary'
            );
        } catch (error) {
            console.error(`❌ Weekly summary error for user ${userId}:`, error.message);
        }
    }

    // ============================================================================
    // SCHEDULED NOTIFICATIONS
    // ============================================================================

    async scheduleNotification(userId, type, title, body, data, delayMinutes) {
        const scheduledFor = new Date(Date.now() + delayMinutes * 60 * 1000);
        await this.pool.query(
            `INSERT INTO scheduled_notifications (user_id, type, title, body, data, scheduled_for)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, type, title, body, JSON.stringify(data), scheduledFor]
        );
    }

    async processPendingNotifications() {
        try {
            const pending = await this.pool.query(`
                SELECT * FROM scheduled_notifications
                WHERE sent = false AND scheduled_for <= NOW()
                ORDER BY scheduled_for ASC
                LIMIT 50
            `);

            for (const notif of pending.rows) {
                await this.sendToUser(notif.user_id, notif.title, notif.body, notif.data, notif.type);
                await this.pool.query(
                    'UPDATE scheduled_notifications SET sent = true WHERE id = $1',
                    [notif.id]
                );
            }

            if (pending.rows.length > 0) {
                console.log(`📱 Processed ${pending.rows.length} scheduled notifications`);
            }
        } catch (error) {
            console.error('❌ processPendingNotifications error:', error.message);
        }
    }

    // ============================================================================
    // HELPERS
    // ============================================================================

    async getPreferences(userId) {
        const result = await this.pool.query(
            'SELECT * FROM notification_preferences WHERE user_id = $1',
            [userId]
        );
        // Return defaults if no preferences set
        return result.rows[0] || {
            trade_opened: true,
            trade_closed: true,
            weekly_summary: true,
            followers: true,
            copy_trade_signals: true
        };
    }

    async removeInvalidToken(token) {
        try {
            await this.pool.query('DELETE FROM device_tokens WHERE token = $1', [token]);
            console.log('🗑️ Removed invalid APNs token');
        } catch (err) {
            console.error('❌ Failed to remove token:', err.message);
        }
    }

    // ============================================================================
    // CRON SETUP
    // ============================================================================

    setupCronJobs(cron) {
        // Process scheduled notifications every minute
        cron.schedule('* * * * *', () => {
            this.processPendingNotifications();
        });

        // Weekly summary every Monday at 9am
        cron.schedule('0 9 * * 1', () => {
            this.sendWeeklySummaries();
        });

        console.log('✅ Notification cron jobs scheduled');
        console.log('   • Pending notifications: every minute');
        console.log('   • Weekly summaries: Mondays at 9am');
    }
}

module.exports = NotificationService;
