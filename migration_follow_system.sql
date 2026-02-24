-- ============================================================================
-- PHASE 2: SOCIAL FEATURES - Follow System
-- ============================================================================
-- Run this SQL migration to add follow functionality

-- Create user_follows table
CREATE TABLE IF NOT EXISTS user_follows (
    id SERIAL PRIMARY KEY,
    follower_id VARCHAR(255) NOT NULL,
    following_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign keys
    CONSTRAINT fk_follower FOREIGN KEY (follower_id) 
        REFERENCES users(public_id) ON DELETE CASCADE,
    CONSTRAINT fk_following FOREIGN KEY (following_id) 
        REFERENCES users(public_id) ON DELETE CASCADE,
    
    -- Prevent duplicate follows
    CONSTRAINT unique_follow UNIQUE (follower_id, following_id),
    
    -- Prevent self-follows
    CONSTRAINT no_self_follow CHECK (follower_id != following_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_following ON user_follows(following_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_created ON user_follows(created_at DESC);

-- Add follower/following count columns to users table (optional, for caching)
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS follower_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS following_count INTEGER DEFAULT 0;

-- Create function to update follower counts
CREATE OR REPLACE FUNCTION update_follow_counts()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Increment follower count for the followed user
        UPDATE users SET follower_count = follower_count + 1 
        WHERE public_id = NEW.following_id;
        
        -- Increment following count for the follower
        UPDATE users SET following_count = following_count + 1 
        WHERE public_id = NEW.follower_id;
        
    ELSIF TG_OP = 'DELETE' THEN
        -- Decrement follower count for the unfollowed user
        UPDATE users SET follower_count = GREATEST(follower_count - 1, 0)
        WHERE public_id = OLD.following_id;
        
        -- Decrement following count for the unfollower
        UPDATE users SET following_count = GREATEST(following_count - 1, 0)
        WHERE public_id = OLD.follower_id;
    END IF;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update counts
DROP TRIGGER IF EXISTS trigger_update_follow_counts ON user_follows;
CREATE TRIGGER trigger_update_follow_counts
AFTER INSERT OR DELETE ON user_follows
FOR EACH ROW EXECUTE FUNCTION update_follow_counts();

-- Initialize counts for existing users
UPDATE users SET 
    follower_count = (
        SELECT COUNT(*) FROM user_follows 
        WHERE following_id = users.public_id
    ),
    following_count = (
        SELECT COUNT(*) FROM user_follows 
        WHERE follower_id = users.public_id
    );

-- Verification queries (run these to check everything is working)
/*
-- Check table structure
SELECT * FROM user_follows LIMIT 5;

-- Check follow counts
SELECT public_id, username, follower_count, following_count 
FROM users 
ORDER BY follower_count DESC 
LIMIT 10;

-- Test follow (replace with real user IDs)
INSERT INTO user_follows (follower_id, following_id)
VALUES ('user1_public_id', 'user2_public_id');

-- Check updated counts
SELECT public_id, username, follower_count, following_count 
FROM users 
WHERE public_id IN ('user1_public_id', 'user2_public_id');
*/

COMMIT;
