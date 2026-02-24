-- ============================================================================
-- PHASE 2: TRADING CORE MODELS - TRADES TABLE
-- ============================================================================

-- Drop existing tables if they exist (for clean install)
DROP TABLE IF EXISTS trade_performance CASCADE;
DROP TABLE IF EXISTS trades CASCADE;

-- ============================================================================
-- TRADES TABLE - Store all user trades
-- ============================================================================

CREATE TABLE trades (
    -- Identity
    id SERIAL PRIMARY KEY,
    trade_id VARCHAR(255) UNIQUE NOT NULL,
    user_id VARCHAR(255) NOT NULL REFERENCES users(public_id) ON DELETE CASCADE,
    
    -- Trade Details
    symbol VARCHAR(20) NOT NULL,
    asset_type VARCHAR(20) NOT NULL DEFAULT 'stock',
    side VARCHAR(10) NOT NULL,
    
    -- Pricing
    quantity DECIMAL(20, 8) NOT NULL,
    entry_price DECIMAL(20, 8) NOT NULL,
    exit_price DECIMAL(20, 8),
    
    -- Fees & Costs
    commission DECIMAL(10, 2) DEFAULT 0,
    fees DECIMAL(10, 2) DEFAULT 0,
    
    -- Profit/Loss (calculated)
    profit_loss DECIMAL(20, 2),
    profit_loss_pct DECIMAL(10, 4),
    
    -- Timing
    opened_at TIMESTAMP NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMP,
    hold_time_hours INTEGER,
    
    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    
    -- Metadata
    notes TEXT,
    tags TEXT[],
    
    -- Strategy (optional)
    strategy VARCHAR(50),
    
    -- Visibility (for social features)
    is_public BOOLEAN DEFAULT true,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_trades_user_id ON trades(user_id);
CREATE INDEX idx_trades_symbol ON trades(symbol);
CREATE INDEX idx_trades_status ON trades(status);
CREATE INDEX idx_trades_opened_at ON trades(opened_at DESC);
CREATE INDEX idx_trades_user_status ON trades(user_id, status);

CREATE TABLE trade_performance (
    user_id VARCHAR(255) PRIMARY KEY REFERENCES users(public_id) ON DELETE CASCADE,
    total_trades INTEGER DEFAULT 0,
    open_positions INTEGER DEFAULT 0,
    closed_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    win_rate DECIMAL(5, 2) DEFAULT 0,
    total_profit_loss DECIMAL(20, 2) DEFAULT 0,
    avg_hold_time_hours DECIMAL(10, 2) DEFAULT 0,
    best_trade_pct DECIMAL(10, 4) DEFAULT 0,
    worst_trade_pct DECIMAL(10, 4) DEFAULT 0,
    last_calculated_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_trades_updated_at BEFORE UPDATE ON trades
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE FUNCTION calculate_trade_metrics()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'closed' AND NEW.exit_price IS NOT NULL THEN
        IF NEW.side = 'buy' THEN
            NEW.profit_loss = (NEW.exit_price - NEW.entry_price) * NEW.quantity - NEW.commission - NEW.fees;
            NEW.profit_loss_pct = ((NEW.exit_price - NEW.entry_price) / NEW.entry_price) * 100;
        ELSE
            NEW.profit_loss = (NEW.entry_price - NEW.exit_price) * NEW.quantity - NEW.commission - NEW.fees;
            NEW.profit_loss_pct = ((NEW.entry_price - NEW.exit_price) / NEW.entry_price) * 100;
        END IF;
        
        IF NEW.closed_at IS NOT NULL THEN
            NEW.hold_time_hours = EXTRACT(EPOCH FROM (NEW.closed_at - NEW.opened_at)) / 3600;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER calculate_trade_metrics_trigger
    BEFORE INSERT OR UPDATE ON trades
    FOR EACH ROW EXECUTE FUNCTION calculate_trade_metrics();
