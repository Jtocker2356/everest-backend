-- ============================================================================
-- EVEREST TRADING PLATFORM - DATABASE SCHEMA v2.0
-- PostgreSQL 14+ with Authentication, Roles, and Security
-- ============================================================================

-- Create database (run this first as superuser if not exists)
-- CREATE DATABASE everest_trading;

-- Connect to the database
\c everest_trading;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- DROP EXISTING TABLES (if re-running)
-- ============================================================================

DROP TABLE IF EXISTS cash_sweeps CASCADE;
DROP TABLE IF EXISTS interest_accruals CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS positions CASCADE;
DROP TABLE IF EXISTS cash_balances CASCADE;
DROP TABLE IF EXISTS user_sessions CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ============================================================================
-- USERS TABLE (with roles and security)
-- ============================================================================

CREATE TABLE users (
    -- Primary identifier (UUID - never expose this directly)
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Public identifier (shown to users, used in URLs)
    public_id VARCHAR(32) UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
    
    -- Authentication
    firebase_uid VARCHAR(128) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    email_verified BOOLEAN DEFAULT false,
    
    -- Personal Info
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone_number VARCHAR(20),
    phone_verified BOOLEAN DEFAULT false,
    
    -- Role System
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'verified', 'admin')),
    
    -- Account Status
    account_status VARCHAR(20) DEFAULT 'pending' CHECK (account_status IN ('pending', 'active', 'suspended', 'closed')),
    
    -- KYC Status
    kyc_status VARCHAR(20) DEFAULT 'not_started' CHECK (kyc_status IN ('not_started', 'pending', 'approved', 'rejected', 'needs_review')),
    kyc_submitted_at TIMESTAMP,
    kyc_approved_at TIMESTAMP,
    
    -- External IDs
    alpaca_account_id VARCHAR(128) UNIQUE,
    plaid_access_token TEXT,
    plaid_item_id VARCHAR(128),
    
    -- Security
    last_login_at TIMESTAMP,
    last_login_ip INET,
    login_count INTEGER DEFAULT 0,
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP,
    
    -- Indexes for performance
    CONSTRAINT valid_email CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$')
);

-- Indexes
CREATE INDEX idx_users_public_id ON users(public_id);
CREATE INDEX idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(account_status, kyc_status);
CREATE INDEX idx_users_created_at ON users(created_at DESC);

COMMENT ON TABLE users IS 'User accounts with role-based access control';
COMMENT ON COLUMN users.id IS 'Internal UUID - never expose in API';
COMMENT ON COLUMN users.public_id IS 'Public identifier - safe to expose';
COMMENT ON COLUMN users.role IS 'user = basic, verified = KYC complete, admin = full access';

-- ============================================================================
-- USER SESSIONS TABLE (for session tracking)
-- ============================================================================

CREATE TABLE user_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Session Info
    session_token VARCHAR(128) UNIQUE NOT NULL,
    firebase_token_hash VARCHAR(64),
    
    -- Device & Location
    user_agent TEXT,
    ip_address INET,
    device_type VARCHAR(50),
    
    -- Session Status
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP NOT NULL,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    last_activity_at TIMESTAMP DEFAULT NOW(),
    revoked_at TIMESTAMP
);

CREATE INDEX idx_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_sessions_token ON user_sessions(session_token);
CREATE INDEX idx_sessions_active ON user_sessions(user_id, is_active, expires_at);

-- ============================================================================
-- CASH BALANCES TABLE
-- ============================================================================

CREATE TABLE cash_balances (
    user_id UUID REFERENCES users(id) PRIMARY KEY,
    
    -- Cash Amounts
    total_cash DECIMAL(15,2) DEFAULT 0.00 CHECK (total_cash >= 0),
    invested_amount DECIMAL(15,2) DEFAULT 0.00 CHECK (invested_amount >= 0),
    available_cash DECIMAL(15,2) DEFAULT 0.00 CHECK (available_cash >= 0),
    pending_orders DECIMAL(15,2) DEFAULT 0.00 CHECK (pending_orders >= 0),
    buying_power DECIMAL(15,2) DEFAULT 0.00 CHECK (buying_power >= 0),
    
    -- Sweep Settings
    swept_cash DECIMAL(15,2) DEFAULT 0.00 CHECK (swept_cash >= 0),
    sweep_enabled BOOLEAN DEFAULT true,
    sweep_threshold DECIMAL(15,2) DEFAULT 100.00 CHECK (sweep_threshold >= 0),
    last_sweep_at TIMESTAMP,
    
    -- Metadata
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Ensure balances make sense
    CONSTRAINT valid_total_cash CHECK (total_cash = available_cash + invested_amount + pending_orders)
);

CREATE INDEX idx_cash_sweep_enabled ON cash_balances(sweep_enabled, available_cash);

COMMENT ON TABLE cash_balances IS 'User cash balances with sweep configuration';

-- ============================================================================
-- POSITIONS TABLE
-- ============================================================================

CREATE TABLE positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Asset Info
    symbol VARCHAR(10) NOT NULL,
    asset_type VARCHAR(20) NOT NULL CHECK (asset_type IN ('stock', 'crypto', 'etf')),
    
    -- Position Details
    quantity DECIMAL(15,8) NOT NULL CHECK (quantity > 0),
    avg_cost DECIMAL(15,4) NOT NULL CHECK (avg_cost > 0),
    current_price DECIMAL(15,4),
    market_value DECIMAL(15,2),
    
    -- P&L
    unrealized_pl DECIMAL(15,2),
    unrealized_pl_percent DECIMAL(10,4),
    
    -- Timestamps
    opened_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(user_id, symbol)
);

CREATE INDEX idx_positions_user ON positions(user_id);
CREATE INDEX idx_positions_symbol ON positions(symbol);
CREATE INDEX idx_positions_user_symbol ON positions(user_id, symbol);

-- ============================================================================
-- ORDERS TABLE
-- ============================================================================

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- External Reference
    alpaca_order_id VARCHAR(128) UNIQUE,
    
    -- Order Details
    symbol VARCHAR(10) NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
    order_type VARCHAR(20) NOT NULL CHECK (order_type IN ('market', 'limit', 'stop', 'stop_limit')),
    
    -- Quantities & Prices
    quantity DECIMAL(15,8) NOT NULL CHECK (quantity > 0),
    limit_price DECIMAL(15,4) CHECK (limit_price IS NULL OR limit_price > 0),
    stop_price DECIMAL(15,4) CHECK (stop_price IS NULL OR stop_price > 0),
    filled_qty DECIMAL(15,8) DEFAULT 0 CHECK (filled_qty >= 0),
    filled_avg_price DECIMAL(15,4),
    
    -- Order Status
    status VARCHAR(50) NOT NULL CHECK (status IN (
        'pending', 'new', 'partially_filled', 'filled', 
        'cancelled', 'expired', 'rejected', 'pending_cancel'
    )),
    time_in_force VARCHAR(20) DEFAULT 'day' CHECK (time_in_force IN ('day', 'gtc', 'ioc', 'fok')),
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    submitted_at TIMESTAMP,
    filled_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    expired_at TIMESTAMP
);

CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(user_id, status);
CREATE INDEX idx_orders_symbol ON orders(symbol);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX idx_orders_alpaca ON orders(alpaca_order_id);

-- ============================================================================
-- TRANSACTIONS TABLE (Ledger)
-- ============================================================================

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Transaction Details
    type VARCHAR(50) NOT NULL CHECK (type IN (
        'deposit', 'withdrawal', 'buy', 'sell', 
        'dividend', 'interest', 'fee', 
        'sweep_out', 'sweep_in', 'transfer'
    )),
    amount DECIMAL(15,2) NOT NULL,
    balance_after DECIMAL(15,2) NOT NULL,
    
    -- References
    reference_id UUID,
    reference_type VARCHAR(50),
    
    -- Description
    description TEXT,
    metadata JSONB,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_date ON transactions(user_id, created_at DESC);
CREATE INDEX idx_transactions_type ON transactions(type, created_at DESC);
CREATE INDEX idx_transactions_reference ON transactions(reference_id);

COMMENT ON TABLE transactions IS 'Immutable ledger of all financial transactions';

-- ============================================================================
-- INTEREST ACCRUALS TABLE
-- ============================================================================

CREATE TABLE interest_accruals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Accrual Details
    accrual_date DATE NOT NULL,
    idle_cash_balance DECIMAL(15,2) NOT NULL CHECK (idle_cash_balance >= 0),
    annual_rate DECIMAL(5,4) NOT NULL CHECK (annual_rate >= 0),
    daily_interest DECIMAL(15,6) NOT NULL CHECK (daily_interest >= 0),
    
    -- Credit Status
    credited BOOLEAN DEFAULT false,
    credited_at TIMESTAMP,
    
    UNIQUE(user_id, accrual_date)
);

CREATE INDEX idx_interest_user_date ON interest_accruals(user_id, accrual_date DESC);
CREATE INDEX idx_interest_uncredited ON interest_accruals(user_id, credited, accrual_date) WHERE credited = false;

-- ============================================================================
-- CASH SWEEPS TABLE
-- ============================================================================

CREATE TABLE cash_sweeps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Sweep Details
    sweep_type VARCHAR(20) NOT NULL CHECK (sweep_type IN ('sweep_out', 'sweep_in')),
    amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
    
    -- Rates
    partner_yield_rate DECIMAL(5,4),
    user_yield_rate DECIMAL(5,4),
    platform_margin DECIMAL(5,4),
    
    -- Timestamps
    executed_at TIMESTAMP DEFAULT NOW(),
    reversed_at TIMESTAMP
);

CREATE INDEX idx_sweeps_user ON cash_sweeps(user_id);
CREATE INDEX idx_sweeps_date ON cash_sweeps(executed_at DESC);
CREATE INDEX idx_sweeps_type ON cash_sweeps(sweep_type, executed_at);

-- ============================================================================
-- FUNCTIONS (Auto-update timestamps)
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers
CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_cash_balances_updated_at 
    BEFORE UPDATE ON cash_balances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_positions_updated_at 
    BEFORE UPDATE ON positions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- SECURITY FUNCTIONS
-- ============================================================================

-- Function to get user by public_id (safe to expose)
CREATE OR REPLACE FUNCTION get_user_by_public_id(p_public_id VARCHAR)
RETURNS TABLE (
    id UUID,
    email VARCHAR,
    first_name VARCHAR,
    last_name VARCHAR,
    role VARCHAR,
    account_status VARCHAR,
    kyc_status VARCHAR,
    created_at TIMESTAMP
) AS $$
BEGIN
    RETURN QUERY
    SELECT u.id, u.email, u.first_name, u.last_name, 
           u.role, u.account_status, u.kyc_status, u.created_at
    FROM users u
    WHERE u.public_id = p_public_id 
      AND u.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to record login
CREATE OR REPLACE FUNCTION record_login(
    p_user_id UUID,
    p_ip_address INET,
    p_success BOOLEAN
)
RETURNS VOID AS $$
BEGIN
    IF p_success THEN
        UPDATE users 
        SET last_login_at = NOW(),
            last_login_ip = p_ip_address,
            login_count = login_count + 1,
            failed_login_attempts = 0
        WHERE id = p_user_id;
    ELSE
        UPDATE users
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE 
                WHEN failed_login_attempts >= 4 THEN NOW() + INTERVAL '30 minutes'
                ELSE locked_until
            END
        WHERE id = p_user_id;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SEED DATA (Development Only)
-- ============================================================================

-- Create admin user (for testing)
INSERT INTO users (
    firebase_uid, email, first_name, last_name, 
    role, account_status, kyc_status, email_verified
)
VALUES (
    'admin-dev-uid-12345', 
    'admin@everest-trading.dev', 
    'Admin', 
    'User',
    'admin', 
    'active', 
    'approved',
    true
)
ON CONFLICT (firebase_uid) DO NOTHING;

-- Initialize admin cash balance
INSERT INTO cash_balances (user_id, total_cash, available_cash, buying_power, sweep_enabled)
SELECT id, 100000.00, 100000.00, 100000.00, true 
FROM users 
WHERE email = 'admin@everest-trading.dev'
ON CONFLICT (user_id) DO NOTHING;

-- Create test user (for testing)
INSERT INTO users (
    firebase_uid, email, first_name, last_name, 
    role, account_status, kyc_status, email_verified
)
VALUES (
    'test-user-uid-67890', 
    'test@everest-trading.dev', 
    'Test', 
    'User',
    'verified', 
    'active', 
    'approved',
    true
)
ON CONFLICT (firebase_uid) DO NOTHING;

-- Initialize test user cash balance
INSERT INTO cash_balances (user_id, total_cash, available_cash, buying_power, sweep_enabled)
SELECT id, 10000.00, 10000.00, 10000.00, true 
FROM users 
WHERE email = 'test@everest-trading.dev'
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================================
-- ANALYTICS VIEWS (for admin dashboard)
-- ============================================================================

CREATE OR REPLACE VIEW user_stats AS
SELECT 
    COUNT(*) as total_users,
    COUNT(*) FILTER (WHERE role = 'admin') as admin_count,
    COUNT(*) FILTER (WHERE role = 'verified') as verified_count,
    COUNT(*) FILTER (WHERE role = 'user') as user_count,
    COUNT(*) FILTER (WHERE account_status = 'active') as active_users,
    COUNT(*) FILTER (WHERE kyc_status = 'approved') as kyc_approved,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as new_users_30d
FROM users
WHERE deleted_at IS NULL;

CREATE OR REPLACE VIEW cash_stats AS
SELECT 
    COUNT(*) as total_accounts,
    SUM(total_cash) as total_cash,
    SUM(available_cash) as total_available,
    SUM(swept_cash) as total_swept,
    SUM(invested_amount) as total_invested,
    AVG(total_cash) as avg_balance,
    COUNT(*) FILTER (WHERE sweep_enabled = true) as sweep_enabled_count
FROM cash_balances;

-- ============================================================================
-- GRANTS (for application user - create if needed)
-- ============================================================================

-- Run this if you have a separate app user:
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO everest_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO everest_app;

-- ============================================================================
-- DONE!
-- ============================================================================

-- Verify tables
SELECT 
    schemaname,
    tablename,
    tableowner
FROM pg_tables 
WHERE schemaname = 'public'
ORDER BY tablename;

COMMENT ON DATABASE everest_trading IS 'Everest Trading Platform v2.0 - Production-Ready with RBAC';