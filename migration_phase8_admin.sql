-- ============================================================================
-- PHASE 8: ADMIN CONTROLS DATABASE MIGRATION
-- User moderation, feature flags, verified badges
-- ============================================================================

-- ============================================================================
-- ADMIN USERS TABLE
-- Track who has admin privileges
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE UNIQUE,
    role VARCHAR(20) DEFAULT 'admin' CHECK(role IN ('super_admin', 'admin', 'moderator')),
    permissions JSONB DEFAULT '{}',
    granted_by VARCHAR(255) REFERENCES users(public_id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_admin_users_role ON admin_users(role);

-- Add first super admin (replace with your user's public_id after creation)
-- INSERT INTO admin_users (user_id, role) VALUES ('YOUR_PUBLIC_ID_HERE', 'super_admin');

-- ============================================================================
-- USER MODERATION TABLE
-- Track suspensions, bans, warnings
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_moderation (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    action VARCHAR(20) NOT NULL CHECK(action IN ('warn', 'suspend', 'ban', 'unsuspend', 'unban')),
    reason TEXT NOT NULL,
    admin_id VARCHAR(255) NOT NULL REFERENCES users(public_id),
    expires_at TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_user_mod_user ON user_moderation(user_id, created_at DESC);
CREATE INDEX idx_user_mod_action ON user_moderation(action, created_at DESC);

-- Add moderation status to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP,
ADD COLUMN IF NOT EXISTS moderation_notes TEXT;

-- ============================================================================
-- FEATURE FLAGS TABLE
-- Control rollout of new features
-- ============================================================================

CREATE TABLE IF NOT EXISTS feature_flags (
    id SERIAL PRIMARY KEY,
    flag_name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    enabled BOOLEAN DEFAULT false,
    rollout_percentage INTEGER DEFAULT 0 CHECK(rollout_percentage BETWEEN 0 AND 100),
    whitelist_user_ids TEXT[] DEFAULT '{}',
    blacklist_user_ids TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_feature_flags_enabled ON feature_flags(enabled) WHERE enabled = true;

-- Common feature flags
INSERT INTO feature_flags (flag_name, description, enabled) VALUES
    ('copy_trading', 'Enable copy trading feature', true),
    ('advanced_charts', 'Advanced charting tools', false),
    ('options_trading', 'Options trading capability', false),
    ('crypto_trading', 'Cryptocurrency trading', true),
    ('margin_trading', 'Margin/leverage trading', false),
    ('social_feed', 'Social trading feed', true),
    ('ai_insights', 'AI-powered trade insights', false)
ON CONFLICT (flag_name) DO NOTHING;

-- ============================================================================
-- CONTENT MODERATION TABLE
-- Hide/unhide specific trades or posts
-- ============================================================================

CREATE TABLE IF NOT EXISTS content_moderation (
    id SERIAL PRIMARY KEY,
    content_type VARCHAR(20) NOT NULL CHECK(content_type IN ('trade', 'feed_event', 'comment', 'profile')),
    content_id INTEGER NOT NULL,
    action VARCHAR(20) NOT NULL CHECK(action IN ('hide', 'unhide', 'delete')),
    reason TEXT NOT NULL,
    admin_id VARCHAR(255) NOT NULL REFERENCES users(public_id),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_content_mod_type ON content_moderation(content_type, content_id);

-- Add is_hidden flag to relevant tables
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;

ALTER TABLE feed_events
ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;

-- ============================================================================
-- VERIFIED BADGE MANAGEMENT
-- Track who gets verified and why
-- ============================================================================

CREATE TABLE IF NOT EXISTS verified_badges (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE UNIQUE,
    badge_type VARCHAR(20) DEFAULT 'verified' CHECK(badge_type IN ('verified', 'pro', 'expert', 'influencer')),
    granted_by VARCHAR(255) NOT NULL REFERENCES users(public_id),
    reason TEXT,
    granted_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP
);

CREATE INDEX idx_verified_user ON verified_badges(user_id);

-- ============================================================================
-- ADMIN ACTIVITY LOG
-- Track all admin actions for accountability
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_activity_log (
    id BIGSERIAL PRIMARY KEY,
    admin_id VARCHAR(255) NOT NULL REFERENCES users(public_id),
    action VARCHAR(50) NOT NULL,
    target_user_id VARCHAR(255) REFERENCES users(public_id),
    target_content_type VARCHAR(20),
    target_content_id INTEGER,
    details JSONB DEFAULT '{}',
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_admin_log_admin ON admin_activity_log(admin_id, created_at DESC);
CREATE INDEX idx_admin_log_action ON admin_activity_log(action, created_at DESC);
CREATE INDEX idx_admin_log_target ON admin_activity_log(target_user_id, created_at DESC);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Check if user is admin
CREATE OR REPLACE FUNCTION is_admin(check_user_id VARCHAR)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS(SELECT 1 FROM admin_users WHERE user_id = check_user_id);
END;
$$ LANGUAGE plpgsql;

-- Check if user can access feature
CREATE OR REPLACE FUNCTION can_access_feature(check_user_id VARCHAR, flag_name VARCHAR)
RETURNS BOOLEAN AS $$
DECLARE
    flag_record RECORD;
    random_val INTEGER;
BEGIN
    SELECT * INTO flag_record FROM feature_flags WHERE feature_flags.flag_name = can_access_feature.flag_name;
    
    IF NOT FOUND THEN RETURN false; END IF;
    IF NOT flag_record.enabled THEN RETURN false; END IF;
    
    -- Check blacklist
    IF check_user_id = ANY(flag_record.blacklist_user_ids) THEN RETURN false; END IF;
    
    -- Check whitelist (whitelist overrides rollout %)
    IF check_user_id = ANY(flag_record.whitelist_user_ids) THEN RETURN true; END IF;
    
    -- Check rollout percentage
    IF flag_record.rollout_percentage = 100 THEN RETURN true; END IF;
    IF flag_record.rollout_percentage = 0 THEN RETURN false; END IF;
    
    -- Hash-based stable rollout
    random_val := (hashtext(check_user_id || flag_name) % 100);
    RETURN random_val < flag_record.rollout_percentage;
END;
$$ LANGUAGE plpgsql;

-- Log admin action
CREATE OR REPLACE FUNCTION log_admin_action(
    p_admin_id VARCHAR,
    p_action VARCHAR,
    p_target_user VARCHAR DEFAULT NULL,
    p_target_type VARCHAR DEFAULT NULL,
    p_target_id INTEGER DEFAULT NULL,
    p_details JSONB DEFAULT '{}'
)
RETURNS void AS $$
BEGIN
    INSERT INTO admin_activity_log (admin_id, action, target_user_id, target_content_type, target_content_id, details)
    VALUES (p_admin_id, p_action, p_target_user, p_target_type, p_target_id, p_details);
END;
$$ LANGUAGE plpgsql;

-- Suspend user
CREATE OR REPLACE FUNCTION suspend_user(
    p_user_id VARCHAR,
    p_admin_id VARCHAR,
    p_reason TEXT,
    p_duration_hours INTEGER DEFAULT NULL
)
RETURNS void AS $$
DECLARE
    expires TIMESTAMP;
BEGIN
    IF p_duration_hours IS NOT NULL THEN
        expires := NOW() + (p_duration_hours || ' hours')::INTERVAL;
    END IF;
    
    UPDATE users SET is_suspended = true, suspended_until = expires WHERE public_id = p_user_id;
    INSERT INTO user_moderation (user_id, action, reason, admin_id, expires_at)
    VALUES (p_user_id, 'suspend', p_reason, p_admin_id, expires);
    PERFORM log_admin_action(p_admin_id, 'SUSPEND_USER', p_user_id, NULL, NULL, 
        jsonb_build_object('reason', p_reason, 'duration_hours', p_duration_hours));
END;
$$ LANGUAGE plpgsql;

-- Ban user
CREATE OR REPLACE FUNCTION ban_user(
    p_user_id VARCHAR,
    p_admin_id VARCHAR,
    p_reason TEXT
)
RETURNS void AS $$
BEGIN
    UPDATE users SET is_banned = true, is_suspended = true WHERE public_id = p_user_id;
    INSERT INTO user_moderation (user_id, action, reason, admin_id)
    VALUES (p_user_id, 'ban', p_reason, p_admin_id);
    PERFORM log_admin_action(p_admin_id, 'BAN_USER', p_user_id, NULL, NULL, jsonb_build_object('reason', p_reason));
END;
$$ LANGUAGE plpgsql;

-- Grant verified badge
CREATE OR REPLACE FUNCTION grant_verified_badge(
    p_user_id VARCHAR,
    p_admin_id VARCHAR,
    p_badge_type VARCHAR DEFAULT 'verified',
    p_reason TEXT DEFAULT NULL
)
RETURNS void AS $$
BEGIN
    INSERT INTO verified_badges (user_id, badge_type, granted_by, reason)
    VALUES (p_user_id, p_badge_type, p_admin_id, p_reason)
    ON CONFLICT (user_id) DO UPDATE SET
        badge_type = p_badge_type,
        granted_by = p_admin_id,
        reason = p_reason,
        granted_at = NOW();
    
    UPDATE users SET is_verified = true WHERE public_id = p_user_id;
    PERFORM log_admin_action(p_admin_id, 'GRANT_VERIFIED_BADGE', p_user_id, NULL, NULL, 
        jsonb_build_object('badge_type', p_badge_type, 'reason', p_reason));
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- VIEWS
-- ============================================================================

-- Active suspensions
CREATE OR REPLACE VIEW active_suspensions AS
SELECT u.public_id, u.username, u.email, u.suspended_until, um.reason, um.created_at as suspended_at
FROM users u
JOIN user_moderation um ON um.user_id = u.public_id
WHERE u.is_suspended = true AND um.action = 'suspend'
AND um.id = (SELECT id FROM user_moderation WHERE user_id = u.public_id AND action = 'suspend' ORDER BY created_at DESC LIMIT 1);

-- Verified users
CREATE OR REPLACE VIEW verified_users AS
SELECT u.public_id, u.username, u.display_name, u.follower_count, 
       vb.badge_type, vb.granted_at, vb.reason
FROM users u
JOIN verified_badges vb ON vb.user_id = u.public_id
WHERE u.is_verified = true
ORDER BY vb.granted_at DESC;

SELECT 'Phase 8 admin controls migration completed!' as message;
