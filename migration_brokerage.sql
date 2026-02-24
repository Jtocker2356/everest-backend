-- ============================================================================
-- BROKERAGE MIGRATION - Real Money Trading
-- Each user gets their own Alpaca brokerage account
-- ============================================================================

-- Add brokerage account fields to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS alpaca_account_id VARCHAR(255) UNIQUE,
ADD COLUMN IF NOT EXISTS alpaca_account_number VARCHAR(50),
ADD COLUMN IF NOT EXISTS alpaca_account_status VARCHAR(50) DEFAULT 'PENDING',
ADD COLUMN IF NOT EXISTS brokerage_account_created_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(50) DEFAULT 'NOT_STARTED',
ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS kyc_approved_at TIMESTAMP;

-- KYC (Know Your Customer) data
CREATE TABLE IF NOT EXISTS kyc_data (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE UNIQUE,
    
    -- Personal Information
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    date_of_birth DATE NOT NULL,
    ssn_last_4 VARCHAR(4),
    ssn_encrypted TEXT, -- Encrypted full SSN
    phone_number VARCHAR(20),
    
    -- Address
    street_address VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(50) NOT NULL,
    postal_code VARCHAR(20) NOT NULL,
    country VARCHAR(3) DEFAULT 'USA',
    
    -- Employment
    employment_status VARCHAR(50), -- 'employed', 'unemployed', 'student', 'retired'
    employer_name VARCHAR(255),
    occupation VARCHAR(100),
    
    -- Financial Profile
    annual_income_range VARCHAR(50), -- '0-25k', '25k-50k', '50k-100k', '100k-200k', '200k+'
    net_worth_range VARCHAR(50),
    liquid_net_worth_range VARCHAR(50),
    
    -- Investment Experience
    investment_experience VARCHAR(50), -- 'none', 'limited', 'good', 'extensive'
    investment_objectives TEXT[],
    risk_tolerance VARCHAR(50), -- 'low', 'medium', 'high'
    
    -- Disclosures
    is_control_person BOOLEAN DEFAULT false,
    is_affiliated_exchange_or_finra BOOLEAN DEFAULT false,
    is_politically_exposed BOOLEAN DEFAULT false,
    
    -- Metadata
    ip_address VARCHAR(45),
    submitted_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_kyc_user ON kyc_data(user_id);

-- Document uploads (ID, proof of address, etc.)
CREATE TABLE IF NOT EXISTS kyc_documents (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    alpaca_document_id VARCHAR(255),
    document_type VARCHAR(50) NOT NULL, -- 'identity', 'address', 'tax_form'
    document_sub_type VARCHAR(50), -- 'passport', 'drivers_license', 'utility_bill'
    file_path TEXT,
    status VARCHAR(50) DEFAULT 'PENDING', -- 'PENDING', 'APPROVED', 'REJECTED'
    uploaded_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_kyc_docs_user ON kyc_documents(user_id);

-- Bank account connections (ACH for deposits/withdrawals)
CREATE TABLE IF NOT EXISTS bank_accounts (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    alpaca_ach_relationship_id VARCHAR(255) UNIQUE,
    plaid_account_id VARCHAR(255),
    
    bank_name VARCHAR(255),
    account_type VARCHAR(20), -- 'CHECKING', 'SAVINGS'
    account_mask VARCHAR(10), -- Last 4 digits
    account_owner_name VARCHAR(255),
    
    status VARCHAR(50) DEFAULT 'PENDING', -- 'PENDING', 'ACTIVE', 'CLOSED'
    is_primary BOOLEAN DEFAULT false,
    
    created_at TIMESTAMP DEFAULT NOW(),
    verified_at TIMESTAMP
);

CREATE INDEX idx_bank_accounts_user ON bank_accounts(user_id);

-- Transfers (deposits & withdrawals)
CREATE TABLE IF NOT EXISTS transfers (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    alpaca_transfer_id VARCHAR(255) UNIQUE,
    bank_account_id INTEGER REFERENCES bank_accounts(id),
    
    amount DECIMAL(15, 2) NOT NULL,
    direction VARCHAR(20) NOT NULL, -- 'INCOMING' (deposit), 'OUTGOING' (withdrawal)
    status VARCHAR(50) DEFAULT 'PENDING', -- 'PENDING', 'QUEUED', 'SENT_TO_CLEARING', 'APPROVED', 'COMPLETE', 'REJECTED', 'CANCELED'
    
    initiated_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    
    notes TEXT
);

CREATE INDEX idx_transfers_user ON transfers(user_id, initiated_at DESC);
CREATE INDEX idx_transfers_status ON transfers(status);

-- Update trades table to link to Alpaca account
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS alpaca_order_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS alpaca_account_id VARCHAR(255);

CREATE INDEX idx_trades_alpaca_order ON trades(alpaca_order_id);

-- Account activity log
CREATE TABLE IF NOT EXISTS account_activity (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    alpaca_account_id VARCHAR(255),
    
    activity_type VARCHAR(50) NOT NULL, -- 'FILL', 'ACATS', 'ACH', 'FEE', 'DIVIDEND', etc.
    transaction_time TIMESTAMP NOT NULL,
    
    symbol VARCHAR(20),
    qty DECIMAL(15, 8),
    price DECIMAL(15, 2),
    amount DECIMAL(15, 2),
    
    description TEXT,
    raw_data JSONB,
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_activity_user ON account_activity(user_id, transaction_time DESC);
CREATE INDEX idx_activity_type ON account_activity(activity_type);

-- Compliance & regulatory
CREATE TABLE IF NOT EXISTS pattern_day_trader_status (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE UNIQUE,
    is_pattern_day_trader BOOLEAN DEFAULT false,
    flagged_at TIMESTAMP,
    day_trades_count INTEGER DEFAULT 0,
    day_trades_reset_at TIMESTAMP,
    
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Trading permissions
CREATE TABLE IF NOT EXISTS trading_permissions (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE UNIQUE,
    
    can_trade_stocks BOOLEAN DEFAULT true,
    can_trade_options BOOLEAN DEFAULT false,
    can_trade_crypto BOOLEAN DEFAULT false,
    can_use_margin BOOLEAN DEFAULT false,
    
    options_level INTEGER DEFAULT 0, -- 0-3 (higher = more complex strategies allowed)
    
    updated_at TIMESTAMP DEFAULT NOW()
);

SELECT 'Brokerage migration completed!' as message;
