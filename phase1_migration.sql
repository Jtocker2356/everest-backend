-- ============================================================================
-- PHASE 1: User Data & Accounts Migration
-- Everest Trading Platform
-- ============================================================================

-- Add user profile fields to existing users table
ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS username VARCHAR(50) UNIQUE,
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS profile_completed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false;

-- Create index on username for fast lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_is_public ON users(is_public);

-- Add constraint: username must be lowercase, alphanumeric + underscore only
ALTER TABLE users 
  ADD CONSTRAINT username_format 
  CHECK (username ~ '^[a-z0-9_]{3,50}$');

-- ============================================================================
-- User Settings Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Trade Visibility Settings
  trade_visibility VARCHAR(20) DEFAULT 'public' CHECK (trade_visibility IN ('public', 'followers', 'private')),
  visibility_delay_minutes INTEGER DEFAULT 0 CHECK (visibility_delay_minutes IN (0, 15, 30, 60, 1440)), -- 0, 15min, 30min, 1hr, 24hr
  
  -- Social Settings
  allow_follow_requests BOOLEAN DEFAULT true,
  show_portfolio_value BOOLEAN DEFAULT true,
  show_positions BOOLEAN DEFAULT true,
  show_returns BOOLEAN DEFAULT true,
  
  -- Notification Settings
  notifications_enabled BOOLEAN DEFAULT true,
  email_notifications BOOLEAN DEFAULT true,
  push_notifications BOOLEAN DEFAULT true,
  notify_on_follow BOOLEAN DEFAULT true,
  notify_on_comment BOOLEAN DEFAULT true,
  notify_on_mention BOOLEAN DEFAULT true,
  
  -- Trading Preferences
  default_order_type VARCHAR(20) DEFAULT 'market' CHECK (default_order_type IN ('market', 'limit', 'stop', 'stop_limit')),
  require_trade_confirmation BOOLEAN DEFAULT true,
  enable_fractional_shares BOOLEAN DEFAULT true,
  
  -- Display Preferences
  theme VARCHAR(20) DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  currency VARCHAR(3) DEFAULT 'USD',
  timezone VARCHAR(50) DEFAULT 'America/New_York',
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Ensure one settings record per user
  CONSTRAINT unique_user_settings UNIQUE(user_id)
);

-- Create index for fast user settings lookup
CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);

-- ============================================================================
-- Trigger: Auto-create user settings on user registration
-- ============================================================================

CREATE OR REPLACE FUNCTION create_default_user_settings()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_settings (user_id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_create_user_settings ON users;
CREATE TRIGGER trigger_create_user_settings
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION create_default_user_settings();

-- ============================================================================
-- Trigger: Update updated_at timestamp
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_user_settings_timestamp ON user_settings;
CREATE TRIGGER trigger_update_user_settings_timestamp
  BEFORE UPDATE ON user_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Create default settings for existing users
-- ============================================================================

INSERT INTO user_settings (user_id)
SELECT id FROM users
WHERE id NOT IN (SELECT user_id FROM user_settings)
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================================
-- Verification
-- ============================================================================

-- Verify migration
DO $$
BEGIN
  RAISE NOTICE 'Phase 1 Migration Complete!';
  RAISE NOTICE 'Users table updated with profile fields';
  RAISE NOTICE 'User settings table created';
  RAISE NOTICE 'Triggers installed';
  RAISE NOTICE '----------------------------------------';
  RAISE NOTICE 'Total users: %', (SELECT COUNT(*) FROM users);
  RAISE NOTICE 'Users with settings: %', (SELECT COUNT(*) FROM user_settings);
END $$;
