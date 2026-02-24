-- ============================================================================
-- PHASE 5: ANTI COPY-TRADING & COMPLIANCE DATABASE MIGRATION
-- Audit logs, copy trade opt-in, rate limiting tracking
-- ============================================================================

-- ============================================================================
-- AUDIT LOG TABLE
-- Tracks all sensitive user actions for compliance
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    action_type VARCHAR(50) NOT NULL,
    target_user_id VARCHAR(255) REFERENCES users(public_id) ON DELETE SET NULL,
    target_trade_id INTEGER REFERENCES trades(id) ON DELETE SET NULL,
    metadata JSONB DEFAULT '{}',
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Action types:
-- FOLLOW, UNFOLLOW, BLOCK, UNBLOCK
-- TRADE_VISIBILITY_CHANGE, PROFILE_VISIBILITY_CHANGE
-- PRIVACY_SETTINGS_CHANGE
-- COPY_TRADE_OPT_IN, COPY_TRADE_OPT_OUT
-- FEED_ACCESS, PROFILE_ACCESS

CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action_type, created_at DESC);
CREATE INDEX idx_audit_target ON audit_logs(target_user_id, created_at DESC);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);

-- ============================================================================
-- COPY TRADE SETTINGS TABLE
-- Users can opt in/out of copy trading
-- ============================================================================

CREATE TABLE IF NOT EXISTS copy_trade_settings (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE UNIQUE,
    allow_copy_trading BOOLEAN DEFAULT false,
    copy_delay_minutes INTEGER DEFAULT 30 CHECK(copy_delay_minutes BETWEEN 0 AND 1440),
    max_copiers INTEGER DEFAULT 0, -- 0 = unlimited
    show_copy_count BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_copy_trade_user ON copy_trade_settings(user_id);
CREATE INDEX idx_copy_trade_allowed ON copy_trade_settings(allow_copy_trading) WHERE allow_copy_trading = true;

-- ============================================================================
-- COPY TRADE RELATIONSHIPS TABLE
-- Tracks who is copying who
-- ============================================================================

CREATE TABLE IF NOT EXISTS copy_trade_relationships (
    id SERIAL PRIMARY KEY,
    copier_user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    trader_user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'active' CHECK(status IN ('active', 'paused', 'stopped')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(copier_user_id, trader_user_id),
    CHECK(copier_user_id != trader_user_id)
);

CREATE INDEX idx_copy_rel_copier ON copy_trade_relationships(copier_user_id, status);
CREATE INDEX idx_copy_rel_trader ON copy_trade_relationships(trader_user_id, status);

-- ============================================================================
-- RATE LIMIT TRACKING TABLE
-- Track feed/API access for rate limiting
-- ============================================================================

CREATE TABLE IF NOT EXISTS rate_limit_log (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    endpoint VARCHAR(100) NOT NULL,
    request_count INTEGER DEFAULT 1,
    window_start TIMESTAMP NOT NULL,
    window_end TIMESTAMP NOT NULL,
    
    UNIQUE(user_id, endpoint, window_start)
);

CREATE INDEX idx_rate_limit_user ON rate_limit_log(user_id, endpoint, window_start);

-- ============================================================================
-- UPDATE USER_SETTINGS
-- Add copy trading fields
-- ============================================================================

ALTER TABLE user_settings
ADD COLUMN IF NOT EXISTS allow_copy_trading BOOLEAN DEFAULT false;

-- ============================================================================
-- UPDATE FEED_EVENTS
-- Remove dollar amounts - only show percentages
-- ============================================================================

-- Add a flag to mark if event is copy-trade eligible
ALTER TABLE feed_events
ADD COLUMN IF NOT EXISTS copy_eligible BOOLEAN DEFAULT false;

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function: Log audit event
CREATE OR REPLACE FUNCTION log_audit_event(
    p_actor_id VARCHAR,
    p_action VARCHAR,
    p_target_user VARCHAR DEFAULT NULL,
    p_target_trade INTEGER DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'
)
RETURNS void AS $$
BEGIN
    INSERT INTO audit_logs (actor_user_id, action_type, target_user_id, target_trade_id, metadata)
    VALUES (p_actor_id, p_action, p_target_user, p_target_trade, p_metadata);
END;
$$ LANGUAGE plpgsql;

-- Function: Check if copy trade is allowed
CREATE OR REPLACE FUNCTION can_copy_trade(copier_id VARCHAR, trader_id VARCHAR)
RETURNS BOOLEAN AS $$
DECLARE
    settings_exists BOOLEAN;
    allows_copying BOOLEAN;
    is_following BOOLEAN;
    max_copiers_val INTEGER;
    current_copiers INTEGER;
BEGIN
    -- Check settings exist and allow copying
    SELECT EXISTS(
        SELECT 1 FROM copy_trade_settings WHERE user_id = trader_id
    ) INTO settings_exists;
    
    IF NOT settings_exists THEN RETURN false; END IF;
    
    SELECT allow_copy_trading, max_copiers INTO allows_copying, max_copiers_val
    FROM copy_trade_settings WHERE user_id = trader_id;
    
    IF NOT allows_copying THEN RETURN false; END IF;
    
    -- Must be following
    SELECT EXISTS(
        SELECT 1 FROM user_follows
        WHERE follower_id = copier_id AND following_id = trader_id AND status = 'accepted'
    ) INTO is_following;
    
    IF NOT is_following THEN RETURN false; END IF;
    
    -- Check max copiers limit
    IF max_copiers_val > 0 THEN
        SELECT COUNT(*) INTO current_copiers
        FROM copy_trade_relationships
        WHERE trader_user_id = trader_id AND status = 'active';
        
        IF current_copiers >= max_copiers_val THEN RETURN false; END IF;
    END IF;
    
    RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Function: Auto-log follow actions (trigger)
CREATE OR REPLACE FUNCTION log_follow_action()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM log_audit_event(
            NEW.follower_id, 'FOLLOW', NEW.following_id, NULL,
            jsonb_build_object('status', NEW.status)
        );
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM log_audit_event(
            OLD.follower_id, 'UNFOLLOW', OLD.following_id, NULL, '{}'
        );
    ELSIF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
        PERFORM log_audit_event(
            NEW.follower_id, 'FOLLOW_STATUS_CHANGE', NEW.following_id, NULL,
            jsonb_build_object('old_status', OLD.status, 'new_status', NEW.status)
        );
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Trigger: Auto-log follow actions
DROP TRIGGER IF EXISTS audit_follow_actions ON user_follows;
CREATE TRIGGER audit_follow_actions
    AFTER INSERT OR UPDATE OR DELETE ON user_follows
    FOR EACH ROW
    EXECUTE FUNCTION log_follow_action();

-- Function: Auto-log privacy changes (trigger)
CREATE OR REPLACE FUNCTION log_privacy_change()
RETURNS TRIGGER AS $$
DECLARE
    user_public_id VARCHAR;
BEGIN
    SELECT public_id INTO user_public_id FROM users WHERE id = NEW.user_id;
    
    IF OLD.hide_trades IS DISTINCT FROM NEW.hide_trades
    OR OLD.trade_delay_minutes IS DISTINCT FROM NEW.trade_delay_minutes
    OR OLD.show_performance_stats IS DISTINCT FROM NEW.show_performance_stats
    OR OLD.show_trade_history IS DISTINCT FROM NEW.show_trade_history
    OR OLD.show_holdings IS DISTINCT FROM NEW.show_holdings THEN
        PERFORM log_audit_event(
            user_public_id, 'PRIVACY_SETTINGS_CHANGE', NULL, NULL,
            jsonb_build_object(
                'old', jsonb_build_object(
                    'hide_trades', OLD.hide_trades,
                    'trade_delay_minutes', OLD.trade_delay_minutes,
                    'show_performance_stats', OLD.show_performance_stats,
                    'show_trade_history', OLD.show_trade_history
                ),
                'new', jsonb_build_object(
                    'hide_trades', NEW.hide_trades,
                    'trade_delay_minutes', NEW.trade_delay_minutes,
                    'show_performance_stats', NEW.show_performance_stats,
                    'show_trade_history', NEW.show_trade_history
                )
            )
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: Auto-log privacy changes
DROP TRIGGER IF EXISTS audit_privacy_changes ON user_settings;
CREATE TRIGGER audit_privacy_changes
    AFTER UPDATE ON user_settings
    FOR EACH ROW
    EXECUTE FUNCTION log_privacy_change();

-- ============================================================================
-- VIEWS
-- ============================================================================

-- View: Safe feed events (no dollar amounts, percentages only)
CREATE OR REPLACE VIEW safe_feed_events AS
SELECT 
    fe.id,
    fe.actor_user_id,
    fe.event_type,
    fe.symbol,
    fe.asset_type,
    fe.side,
    -- NO quantity, entry_price, exit_price, profit_loss
    fe.return_pct,      -- percentage only
    fe.strategy_tag,
    fe.visible_after,
    fe.is_public,
    fe.copy_eligible,
    fe.created_at,
    u.username,
    u.display_name,
    u.avatar_url,
    u.is_verified,
    cts.allow_copy_trading,
    cts.copy_delay_minutes
FROM feed_events fe
JOIN users u ON fe.actor_user_id = u.public_id
LEFT JOIN copy_trade_settings cts ON cts.user_id = fe.actor_user_id
WHERE fe.visible_after <= NOW();

-- ============================================================================
-- COMPLIANCE COMMENTS
-- ============================================================================

COMMENT ON TABLE audit_logs IS 'Compliance audit log for all sensitive user actions';
COMMENT ON TABLE copy_trade_settings IS 'User opt-in settings for copy trading feature';
COMMENT ON TABLE copy_trade_relationships IS 'Active copy trading relationships between users';
COMMENT ON VIEW safe_feed_events IS 'Feed events with dollar amounts removed for compliance';
COMMENT ON COLUMN copy_trade_settings.copy_delay_minutes IS 'Delay before copy trade signals are sent (default 30 min)';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

SELECT 'Phase 5 Anti Copy-Trading & Compliance migration completed successfully!' as message;
