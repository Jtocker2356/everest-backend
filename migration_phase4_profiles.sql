-- ============================================================================
-- PHASE 4: PUBLIC TRADER PROFILES DATABASE MIGRATION
-- Privacy toggles, strategy tags, public profile data
-- ============================================================================

-- ============================================================================
-- STRATEGY TAGS TABLE
-- Users can tag their trades with strategies for followers to see
-- ============================================================================

CREATE TABLE IF NOT EXISTS strategy_tags (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    tag_name VARCHAR(50) NOT NULL,
    color VARCHAR(7) DEFAULT '#3b82f6', -- hex color code
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(user_id, tag_name)
);

CREATE INDEX idx_strategy_tags_user ON strategy_tags(user_id);

-- ============================================================================
-- UPDATE USER_SETTINGS TABLE
-- Add privacy controls for public profiles
-- ============================================================================

-- Add privacy columns to user_settings if they don't exist
ALTER TABLE user_settings 
ADD COLUMN IF NOT EXISTS hide_trades BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS trade_delay_minutes INTEGER DEFAULT 0 CHECK(trade_delay_minutes BETWEEN 0 AND 60),
ADD COLUMN IF NOT EXISTS show_performance_stats BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS show_trade_history BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS show_holdings BOOLEAN DEFAULT false;

-- ============================================================================
-- UPDATE TRADES TABLE
-- Add strategy tag support
-- ============================================================================

-- Add strategy column to trades (references tag_name, not FK to allow flexibility)
ALTER TABLE trades 
ADD COLUMN IF NOT EXISTS strategy_tag VARCHAR(50);

-- ============================================================================
-- UPDATE FEED_EVENTS TABLE
-- Store strategy tag in feed events
-- ============================================================================

ALTER TABLE feed_events
ADD COLUMN IF NOT EXISTS strategy_tag VARCHAR(50);

-- ============================================================================
-- VIEWS FOR PUBLIC PROFILES
-- ============================================================================

-- View: Public user profile with aggregated data
CREATE OR REPLACE VIEW public_user_profiles AS
SELECT 
    u.public_id,
    u.username,
    u.display_name,
    u.bio,
    u.avatar_url,
    u.is_verified,
    u.is_public,
    u.follower_count,
    u.following_count,
    u.created_at as joined_at,
    
    -- Privacy settings (only if show_performance_stats is true)
    CASE 
        WHEN us.show_performance_stats THEN tp.win_rate 
        ELSE NULL 
    END as win_rate,
    CASE 
        WHEN us.show_performance_stats THEN tp.total_profit_loss 
        ELSE NULL 
    END as total_profit_loss,
    CASE 
        WHEN us.show_performance_stats THEN tp.total_trades 
        ELSE NULL 
    END as total_trades,
    CASE 
        WHEN us.show_performance_stats THEN tp.best_trade_pct 
        ELSE NULL 
    END as best_trade_pct,
    
    -- Privacy toggles
    us.show_performance_stats,
    us.show_trade_history,
    us.show_holdings,
    us.hide_trades,
    us.trade_delay_minutes
    
FROM users u
LEFT JOIN user_settings us ON u.id = us.user_id
LEFT JOIN trade_performance tp ON u.public_id = tp.user_id
WHERE u.deleted_at IS NULL;

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function: Get user's strategy tags
CREATE OR REPLACE FUNCTION get_user_strategy_tags(user_public_id VARCHAR)
RETURNS TABLE(tag_name VARCHAR, color VARCHAR, trade_count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        st.tag_name,
        st.color,
        COUNT(t.id) as trade_count
    FROM strategy_tags st
    LEFT JOIN trades t ON t.user_id = user_public_id AND t.strategy_tag = st.tag_name
    WHERE st.user_id = user_public_id
    GROUP BY st.tag_name, st.color
    ORDER BY trade_count DESC;
END;
$$ LANGUAGE plpgsql;

-- Function: Check if user can view another user's profile data
CREATE OR REPLACE FUNCTION can_view_profile_data(
    viewer_id VARCHAR,
    profile_id VARCHAR,
    data_type VARCHAR -- 'trades', 'performance', 'holdings'
)
RETURNS BOOLEAN AS $$
DECLARE
    is_following BOOLEAN;
    is_public_account BOOLEAN;
    show_data BOOLEAN;
    is_blocked BOOLEAN;
BEGIN
    -- Check if blocked
    SELECT EXISTS(
        SELECT 1 FROM user_blocks
        WHERE (blocker_id = viewer_id AND blocked_id = profile_id)
           OR (blocker_id = profile_id AND blocked_id = viewer_id)
    ) INTO is_blocked;
    
    IF is_blocked THEN
        RETURN false;
    END IF;
    
    -- Viewer is the profile owner
    IF viewer_id = profile_id THEN
        RETURN true;
    END IF;
    
    -- Get user's public status and privacy settings
    SELECT u.is_public INTO is_public_account
    FROM users u WHERE u.public_id = profile_id;
    
    -- Check if viewer is following
    SELECT EXISTS(
        SELECT 1 FROM user_follows
        WHERE follower_id = viewer_id 
        AND following_id = profile_id 
        AND status = 'accepted'
    ) INTO is_following;
    
    -- Must be public OR following to view
    IF NOT (is_public_account OR is_following) THEN
        RETURN false;
    END IF;
    
    -- Check specific data type permissions
    IF data_type = 'trades' THEN
        SELECT show_trade_history INTO show_data
        FROM user_settings us
        JOIN users u ON u.id = us.user_id
        WHERE u.public_id = profile_id;
    ELSIF data_type = 'performance' THEN
        SELECT show_performance_stats INTO show_data
        FROM user_settings us
        JOIN users u ON u.id = us.user_id
        WHERE u.public_id = profile_id;
    ELSIF data_type = 'holdings' THEN
        SELECT show_holdings INTO show_data
        FROM user_settings us
        JOIN users u ON u.id = us.user_id
        WHERE u.public_id = profile_id;
    ELSE
        RETURN false;
    END IF;
    
    RETURN COALESCE(show_data, false);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SAMPLE DATA (optional - uncomment to add default strategy tags)
-- ============================================================================

-- INSERT INTO strategy_tags (user_id, tag_name, color) VALUES
-- ('your-user-id', 'Day Trading', '#ef4444'),
-- ('your-user-id', 'Swing Trading', '#3b82f6'),
-- ('your-user-id', 'Long Term', '#10b981'),
-- ('your-user-id', 'Momentum', '#f59e0b'),
-- ('your-user-id', 'Value', '#8b5cf6');

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE strategy_tags IS 'User-defined strategy tags for categorizing trades';
COMMENT ON COLUMN user_settings.hide_trades IS 'Completely hide all trades from public view';
COMMENT ON COLUMN user_settings.trade_delay_minutes IS 'Delay in minutes before trades appear in feed (0-60)';
COMMENT ON COLUMN user_settings.show_performance_stats IS 'Show win rate, P&L, etc on public profile';
COMMENT ON COLUMN user_settings.show_trade_history IS 'Show past trades on public profile';
COMMENT ON COLUMN user_settings.show_holdings IS 'Show current positions on public profile';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

SELECT 'Phase 4 Public Trader Profiles migration completed successfully!' as message;
