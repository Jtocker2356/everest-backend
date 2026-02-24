-- ============================================================================
-- PHASE 6: NOTIFICATIONS DATABASE MIGRATION
-- Device tokens, notification log, notification preferences
-- ============================================================================

-- Device tokens table - stores APNs tokens per user/device
CREATE TABLE IF NOT EXISTS device_tokens (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    device_name VARCHAR(100),
    platform VARCHAR(10) DEFAULT 'ios',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, token)
);

CREATE INDEX idx_device_tokens_user ON device_tokens(user_id);

-- Notification preferences - per user settings
CREATE TABLE IF NOT EXISTS notification_preferences (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE UNIQUE,
    trade_opened BOOLEAN DEFAULT true,
    trade_closed BOOLEAN DEFAULT true,
    weekly_summary BOOLEAN DEFAULT true,
    followers BOOLEAN DEFAULT true,
    copy_trade_signals BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notif_prefs_user ON notification_preferences(user_id);

-- Notification log - track every notification sent
CREATE TABLE IF NOT EXISTS notification_log (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data JSONB DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'sent',
    apns_id TEXT,
    sent_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notif_log_user ON notification_log(user_id, sent_at DESC);
CREATE INDEX idx_notif_log_type ON notification_log(type, sent_at DESC);

-- Scheduled notifications - for delayed trade alerts
CREATE TABLE IF NOT EXISTS scheduled_notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data JSONB DEFAULT '{}',
    scheduled_for TIMESTAMP NOT NULL,
    sent BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sched_notif_pending ON scheduled_notifications(scheduled_for, sent) WHERE sent = false;

SELECT 'Phase 6 notifications migration completed!' as message;
