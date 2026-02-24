// ============================================================================
// PHASE 2: TRADE SYNC SERVICE
// Automatically syncs Alpaca orders to your trades database
// ============================================================================

const cron = require('node-cron');

class TradeSyncService {
  constructor(pool, alpacaClient) {
    this.pool = pool;
    this.alpaca = alpacaClient;
    this.syncInterval = null;
  }

  startAutoSync() {
    console.log('⏰ Starting trade sync service (every 5 minutes)...');
    this.syncAllUserTrades();
    this.syncInterval = cron.schedule('*/5 * * * *', () => {
      console.log('🔄 Running scheduled trade sync...');
      this.syncAllUserTrades();
    });
    console.log('✅ Trade sync service started');
  }

  stopAutoSync() {
    if (this.syncInterval) {
      this.syncInterval.stop();
      console.log('⏹️  Trade sync service stopped');
    }
  }

  async syncAllUserTrades() {
    try {
      const result = await this.pool.query(
        'SELECT public_id, email FROM users'
      );
      
      console.log(`📊 Syncing trades for ${result.rows.length} users...`);
      
      for (const user of result.rows) {
        await this.syncUserTrades(user.public_id);
      }
      
      console.log('✅ Trade sync complete');
    } catch (error) {
      console.error('❌ Error in syncAllUserTrades:', error);
    }
  }

  async syncUserTrades(userId) {
    try {
      const orders = await this.fetchAlpacaOrders();
      
      if (!orders || orders.length === 0) {
        return;
      }

      let synced = 0;
      let skipped = 0;

      for (const order of orders) {
        const saved = await this.saveTradeToDatabase(userId, order);
        if (saved) synced++;
        else skipped++;
      }

      if (synced > 0) {
        console.log(`✅ Synced ${synced} trades for user ${userId.substring(0, 8)}`);
        await this.recalculatePerformance(userId);
      }
      
    } catch (error) {
      console.error(`❌ Error syncing trades for user ${userId}:`, error);
    }
  }

  async fetchAlpacaOrders() {
    try {
      const orders = await this.alpaca.getOrders({
        status: 'all',
        limit: 500,
        after: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
      });

      return orders.filter(order => order.status === 'filled');
    } catch (error) {
      console.error('❌ Error fetching Alpaca orders:', error);
      return [];
    }
  }

  async saveTradeToDatabase(userId, order) {
    try {
      const existing = await this.pool.query(
        'SELECT id FROM trades WHERE trade_id = $1',
        [order.id]
      );

      if (existing.rows.length > 0) {
        return false;
      }

      const assetType = this.getAssetType(order.symbol);

      const trade = {
        trade_id: order.id,
        user_id: userId,
        symbol: order.symbol,
        asset_type: assetType,
        side: order.side,
        quantity: parseFloat(order.filled_qty || order.qty),
        entry_price: parseFloat(order.filled_avg_price || order.limit_price || 0),
        exit_price: null,
        commission: 0,
        fees: 0,
        status: 'closed',
        opened_at: new Date(order.created_at),
        closed_at: new Date(order.filled_at || order.updated_at),
        is_public: true
      };

      await this.pool.query(`
        INSERT INTO trades (
          trade_id, user_id, symbol, asset_type, side,
          quantity, entry_price, exit_price, commission, fees,
          status, opened_at, closed_at, is_public
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (trade_id) DO NOTHING
      `, [
        trade.trade_id, trade.user_id, trade.symbol, trade.asset_type, trade.side,
        trade.quantity, trade.entry_price, trade.exit_price, trade.commission, trade.fees,
        trade.status, trade.opened_at, trade.closed_at, trade.is_public
      ]);

      return true;
    } catch (error) {
      console.error('❌ Error saving trade:', error);
      return false;
    }
  }

  async syncOpenPositions(userId) {
    try {
      const positions = await this.alpaca.getPositions();

      for (const position of positions) {
        const existing = await this.pool.query(
          'SELECT id FROM trades WHERE user_id = $1 AND symbol = $2 AND status = $3',
          [userId, position.symbol, 'open']
        );

        if (existing.rows.length === 0) {
          await this.pool.query(`
            INSERT INTO trades (
              trade_id, user_id, symbol, asset_type, side,
              quantity, entry_price, status, opened_at, is_public
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            `POS_${position.asset_id}`,
            userId,
            position.symbol,
            this.getAssetType(position.symbol),
            position.side,
            Math.abs(parseFloat(position.qty)),
            parseFloat(position.avg_entry_price),
            'open',
            new Date(position.created_at || Date.now()),
            true
          ]);
        }
      }
    } catch (error) {
      console.error('❌ Error syncing positions:', error);
    }
  }

  async recalculatePerformance(userId) {
    try {
      const result = await this.pool.query(`
        SELECT 
          COUNT(*) as total_trades,
          COUNT(*) FILTER (WHERE status = 'open') as open_positions,
          COUNT(*) FILTER (WHERE status = 'closed') as closed_trades,
          COUNT(*) FILTER (WHERE profit_loss > 0) as winning_trades,
          COUNT(*) FILTER (WHERE profit_loss < 0) as losing_trades,
          COALESCE(SUM(profit_loss), 0) as total_profit_loss,
          COALESCE(AVG(hold_time_hours), 0) as avg_hold_time,
          COALESCE(MAX(profit_loss_pct), 0) as best_trade_pct,
          COALESCE(MIN(profit_loss_pct), 0) as worst_trade_pct
        FROM trades
        WHERE user_id = $1
      `, [userId]);

      const stats = result.rows[0];
      
      const winRate = stats.closed_trades > 0 
        ? (stats.winning_trades / stats.closed_trades) * 100 
        : 0;

      await this.pool.query(`
        INSERT INTO trade_performance (
          user_id, total_trades, open_positions, closed_trades,
          winning_trades, losing_trades, win_rate,
          total_profit_loss, avg_hold_time_hours,
          best_trade_pct, worst_trade_pct, last_calculated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          total_trades = $2,
          open_positions = $3,
          closed_trades = $4,
          winning_trades = $5,
          losing_trades = $6,
          win_rate = $7,
          total_profit_loss = $8,
          avg_hold_time_hours = $9,
          best_trade_pct = $10,
          worst_trade_pct = $11,
          last_calculated_at = NOW()
      `, [
        userId, stats.total_trades, stats.open_positions, stats.closed_trades,
        stats.winning_trades, stats.losing_trades, winRate,
        stats.total_profit_loss, stats.avg_hold_time,
        stats.best_trade_pct, stats.worst_trade_pct
      ]);
    } catch (error) {
      console.error('❌ Error calculating performance:', error);
    }
  }

  getAssetType(symbol) {
    if (symbol.includes('USD') && symbol.length > 5) return 'crypto';
    const etfs = ['SPY', 'QQQ', 'DIA', 'IWM', 'VOO', 'VTI', 'ARKK', 'GLD', 'SLV'];
    if (etfs.includes(symbol)) return 'etf';
    return 'stock';
  }

  async manualSync(userId) {
    console.log(`🔄 Manual sync triggered for user ${userId}`);
    await this.syncUserTrades(userId);
    await this.syncOpenPositions(userId);
    console.log(`✅ Manual sync complete for user ${userId}`);
  }
}

module.exports = TradeSyncService;
