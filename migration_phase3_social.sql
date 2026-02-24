-- ============================================================================
-- PHASE 3: SOCIAL LAYER DATABASE MIGRATION
-- Followers system with approval + Feed events for social trading
-- ============================================================================

-- Drop existing tables if they exist
DROP TABLE IF EXISTS feed_events CASCADE;
DROP TABLE IF EXISTS user_blocks CASCADE;
DROP TABLE IF EXISTS follow_requests CASCADE;

-- ============================================================================
-- FOLLOWERS TABLE (already exists, but add approval system)
-- ============================================================================

-- Add columns to user_follows if they don't exist
ALTER TABLE user_follows 
ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'accepted',
ADD COLUMN IF NOT EXISTS requested_at TIMESTAMP DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP;

-- Update existing follows to be accepted
UPDATE user_follows SET status = 'accepted', accepted_at = created_at WHERE status IS NULL;

-- Create index for pending follow requests
CREATE INDEX IF NOT EXISTS idx_user_follows_pending ON user_follows(following_id, status) WHERE status = 'pending';

-- ============================================================================
-- USER BLOCKS TABLE
-- Users can block other users from seeing their content
-- ============================================================================

CREATE TABLE user_blocks (
    id SERIAL PRIMARY KEY,
    blocker_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    blocked_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(blocker_id, blocked_id),
    CHECK(blocker_id != blocked_id)
);

CREATE INDEX idx_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX idx_blocks_blocked ON user_blocks(blocked_id);

-- ============================================================================
-- FEED EVENTS TABLE
-- Social trading feed - shows trades from people you follow
-- ============================================================================

CREATE TABLE feed_events (
    id SERIAL PRIMARY KEY,
    actor_user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    
    -- Event details
    event_type VARCHAR(20) NOT NULL CHECK(event_type IN ('OPEN', 'CLOSE')),
    trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
    
    -- Trade snapshot (for quick feed display without joins)
    symbol VARCHAR(20) NOT NULL,
    asset_type VARCHAR(20) NOT NULL,
    side VARCHAR(10) NOT NULL,
    quantity DECIMAL(20, 8) NOT NULL,
    entry_price DECIMAL(20, 8) NOT NULL,
    exit_price DECIMAL(20, 8),
    return_pct DECIMAL(10, 4), -- null for OPEN events
    profit_loss DECIMAL(20, 8), -- null for OPEN events
    
    -- Privacy & visibility
    visible_after TIMESTAMP NOT NULL, -- delays can be applied (0-60 minutes)
    is_public BOOLEAN DEFAULT true,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for efficient feed queries
CREATE INDEX idx_feed_actor ON feed_events(actor_user_id, created_at DESC);
CREATE INDEX idx_feed_visible ON feed_events(visible_after, is_public) WHERE is_public = true;
CREATE INDEX idx_feed_type ON feed_events(event_type, visible_after);
CREATE INDEX idx_feed_symbol ON feed_events(symbol, created_at DESC);

-- Composite index for main feed query (followers + time + visibility)
CREATE INDEX idx_feed_query ON feed_events(actor_user_id, visible_after DESC, is_public) 
WHERE is_public = true AND visible_after <= NOW();

-- ============================================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================================

-- Function: Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_feed_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: Update feed_events updated_at
CREATE TRIGGER update_feed_events_updated_at
    BEFORE UPDATE ON feed_events
    FOR EACH ROW
    EXECUTE FUNCTION update_feed_updated_at();

-- Function: Create feed event when trade is opened/closed
CREATE OR REPLACE FUNCTION create_feed_event_from_trade()
RETURNS TRIGGER AS $$
DECLARE
    delay_minutes INTEGER;
    event_type_val VARCHAR(20);
BEGIN
    -- Get user's visibility delay from settings (default 0 minutes)
    SELECT COALESCE(visibility_delay_minutes, 0) INTO delay_minutes
    FROM user_settings WHERE user_id = (
        SELECT id FROM users WHERE public_id = NEW.user_id
    );
    
    -- Determine event type
    IF NEW.status = 'open' THEN
        event_type_val := 'OPEN';
    ELSIF NEW.status = 'closed' THEN
        event_type_val := 'CLOSE';
    ELSE
        RETURN NEW; -- Don't create event for other statuses
    END IF;
    
    -- Insert feed event
    INSERT INTO feed_events (
        actor_user_id,
        event_type,
        trade_id,
        symbol,
        asset_type,
        side,
        quantity,
        entry_price,
        exit_price,
        return_pct,
        profit_loss,
        visible_after,
        is_public
    ) VALUES (
        NEW.user_id,
        event_type_val,
        NEW.id,
        NEW.symbol,
        NEW.asset_type,
        NEW.side,
        NEW.quantity,
        NEW.entry_price,
        NEW.exit_price,
        NEW.profit_loss_pct,
        NEW.profit_loss,
        NOW() + (delay_minutes || ' minutes')::INTERVAL,
        NEW.is_public
    );
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: Create feed events from trades
CREATE TRIGGER create_feed_on_trade
    AFTER INSERT OR UPDATE OF status ON trades
    FOR EACH ROW
    WHEN (NEW.status IN ('open', 'closed'))
    EXECUTE FUNCTION create_feed_event_from_trade();

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- View: Feed with user info (for easier querying)
CREATE OR REPLACE VIEW feed_with_users AS
SELECT 
    fe.*,
    u.username,
    u.display_name,
    u.avatar_url,
    u.is_verified
FROM feed_events fe
JOIN users u ON fe.actor_user_id = u.public_id
WHERE fe.visible_after <= NOW();

-- ============================================================================
-- SAMPLE QUERIES (for testing)
-- ============================================================================

-- Get feed for a user (shows trades from people they follow)
-- SELECT * FROM feed_events 
-- WHERE actor_user_id IN (
--     SELECT following_id FROM user_follows 
--     WHERE follower_id = 'USER_ID' AND status = 'accepted'
-- )
-- AND visible_after <= NOW()
-- AND is_public = true
-- AND actor_user_id NOT IN (
--     SELECT blocked_id FROM user_blocks WHERE blocker_id = 'USER_ID'
-- )
-- ORDER BY visible_after DESC
-- LIMIT 50;

-- Get pending follow requests for a user
-- SELECT uf.*, u.username, u.display_name, u.avatar_url
-- FROM user_follows uf
-- JOIN users u ON uf.follower_id = u.public_id
-- WHERE uf.following_id = 'USER_ID' AND uf.status = 'pending';

-- ============================================================================

COMMENT ON TABLE feed_events IS 'Social trading feed - tracks trade opens/closes from followed users';
COMMENT ON TABLE user_blocks IS 'User blocking system for privacy control';
COMMENT ON COLUMN feed_events.visible_after IS 'When this event becomes visible (allows delays 0-60 min)';
COMMENT ON COLUMN user_follows.status IS 'accepted | pending | rejected - for private account approvals';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

SELECT 'Phase 3 Social Layer migration completed successfully!' as message;
