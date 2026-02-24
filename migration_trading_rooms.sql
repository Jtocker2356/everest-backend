-- ============================================================================
-- TRADING ROOMS FEATURE
-- Discord-style chat rooms for trading discussions
-- ============================================================================

-- Trading Rooms
CREATE TABLE IF NOT EXISTS trading_rooms (
    id SERIAL PRIMARY KEY,
    room_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    creator_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    is_live BOOLEAN DEFAULT false,
    is_public BOOLEAN DEFAULT true,
    max_members INTEGER DEFAULT 100,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Room Members
CREATE TABLE IF NOT EXISTS room_members (
    id SERIAL PRIMARY KEY,
    room_id INTEGER REFERENCES trading_rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member', -- 'creator', 'moderator', 'member'
    joined_at TIMESTAMP DEFAULT NOW(),
    last_active_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(room_id, user_id)
);

-- Room Messages
CREATE TABLE IF NOT EXISTS room_messages (
    id BIGSERIAL PRIMARY KEY,
    room_id INTEGER REFERENCES trading_rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    message_type VARCHAR(20) DEFAULT 'text', -- 'text', 'trade_alert', 'system'
    content TEXT NOT NULL,
    
    -- For trade alerts
    symbol VARCHAR(20),
    trade_action VARCHAR(10), -- 'buy', 'sell', 'watch'
    price DECIMAL(15, 2),
    
    created_at TIMESTAMP DEFAULT NOW()
);

-- Room Invites (for private rooms)
CREATE TABLE IF NOT EXISTS room_invites (
    id SERIAL PRIMARY KEY,
    room_id INTEGER REFERENCES trading_rooms(id) ON DELETE CASCADE,
    invited_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
    invite_code VARCHAR(50) UNIQUE NOT NULL,
    max_uses INTEGER,
    uses INTEGER DEFAULT 0,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_trading_rooms_creator ON trading_rooms(creator_id);
CREATE INDEX idx_trading_rooms_live ON trading_rooms(is_live) WHERE is_live = true;
CREATE INDEX idx_room_members_room ON room_members(room_id);
CREATE INDEX idx_room_members_user ON room_members(user_id);
CREATE INDEX idx_room_messages_room ON room_messages(room_id, created_at DESC);
CREATE INDEX idx_room_messages_user ON room_messages(user_id);

-- View for room stats
CREATE OR REPLACE VIEW room_stats AS
SELECT 
    tr.id,
    tr.room_id,
    tr.name,
    tr.description,
    tr.is_live,
    tr.is_public,
    u.username as creator_username,
    u.public_id as creator_public_id,
    COUNT(DISTINCT rm.user_id) as member_count,
    COUNT(DISTINCT msg.id) as message_count,
    MAX(msg.created_at) as last_message_at,
    tr.created_at
FROM trading_rooms tr
LEFT JOIN users u ON u.id = tr.creator_id
LEFT JOIN room_members rm ON rm.room_id = tr.id
LEFT JOIN room_messages msg ON msg.room_id = tr.id
GROUP BY tr.id, u.username, u.public_id;

-- Function to auto-add creator as member
CREATE OR REPLACE FUNCTION add_creator_as_member()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO room_members (room_id, user_id, role)
    VALUES (NEW.id, NEW.creator_id, 'creator');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_room_created
    AFTER INSERT ON trading_rooms
    FOR EACH ROW
    EXECUTE FUNCTION add_creator_as_member();

SELECT 'Trading Rooms migration completed!' as message;
