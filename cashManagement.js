// cashManagement.js - Cash Sweep & Interest System
const cron = require('node-cron');

// ============================================================================
// CASH SWEEP CONFIGURATION
// ============================================================================

const SWEEP_CONFIG = {
  // Yield rates
  partnerBankRate: 0.048,  // 4.8% (what bank pays us)
  userRate: 0.040,         // 4.0% (what user gets)
  platformMargin: 0.008,   // 0.8% (Everest keeps)
  
  // Sweep settings
  defaultThreshold: 100.00, // Minimum cash to sweep
  sweepEnabled: true,
};

// ============================================================================
// CASH SWEEP FUNCTIONS
// ============================================================================

/**
 * Sweep idle cash for a single user
 */
async function sweepUserCash(pool, userId) {
  try {
    // Get user's current balance
    const balanceResult = await pool.query(
      `SELECT available_cash, swept_cash, sweep_threshold, sweep_enabled 
       FROM cash_balances 
       WHERE user_id = $1`,
      [userId]
    );
    
    if (balanceResult.rows.length === 0) {
      console.log(`⚠️  User ${userId} not found`);
      return { success: false, reason: 'User not found' };
    }
    
    const balance = balanceResult.rows[0];
    
    // Check if sweep is enabled
    if (!balance.sweep_enabled) {
      return { success: false, reason: 'Sweep disabled' };
    }
    
    const availableCash = parseFloat(balance.available_cash);
    const sweepThreshold = parseFloat(balance.sweep_threshold);
    
    // Check if we have enough cash to sweep
    if (availableCash < sweepThreshold) {
      return { success: false, reason: 'Below threshold' };
    }
    
    const amountToSweep = availableCash;
    
    // Record the sweep
    await pool.query(
      `INSERT INTO cash_sweeps (
        user_id, sweep_type, amount, 
        partner_yield_rate, user_yield_rate, platform_margin
      )
      VALUES ($1, 'sweep_out', $2, $3, $4, $5)`,
      [userId, amountToSweep, SWEEP_CONFIG.partnerBankRate, 
       SWEEP_CONFIG.userRate, SWEEP_CONFIG.platformMargin]
    );
    
    // Update cash balances
    await pool.query(
      `UPDATE cash_balances 
       SET available_cash = 0,
           swept_cash = swept_cash + $1,
           last_sweep_at = NOW()
       WHERE user_id = $2`,
      [amountToSweep, userId]
    );
    
    // Log transaction
    await logTransaction(pool, userId, 'sweep_out', amountToSweep, 
      `Cash swept to savings account`);
    
    console.log(`✅ Swept $${amountToSweep.toFixed(2)} for user ${userId}`);
    
    return { 
      success: true, 
      sweptAmount: amountToSweep,
      newSweptBalance: parseFloat(balance.swept_cash) + amountToSweep
    };
    
  } catch (error) {
    console.error(`❌ Error sweeping cash for user ${userId}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Sweep idle cash for all users (runs hourly)
 */
async function sweepAllUsers(pool) {
  console.log('🔄 Starting hourly cash sweep...');
  
  try {
    // Get all users with sweep enabled and cash above threshold
    const usersResult = await pool.query(`
      SELECT user_id, available_cash, sweep_threshold 
      FROM cash_balances
      WHERE sweep_enabled = true
        AND available_cash >= sweep_threshold
    `);
    
    let totalSwept = 0;
    let successCount = 0;
    
    for (const user of usersResult.rows) {
      const result = await sweepUserCash(pool, user.user_id);
      if (result.success) {
        totalSwept += result.sweptAmount;
        successCount++;
      }
    }
    
    console.log(`✅ Sweep complete: ${successCount} users, $${totalSwept.toFixed(2)} total swept`);
    
    return { success: true, usersSwept: successCount, totalAmount: totalSwept };
    
  } catch (error) {
    console.error('❌ Error in sweepAllUsers:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Reverse sweep (pull cash back for trading)
 */
async function reverseSweep(pool, userId, amount) {
  try {
    // Get current swept cash
    const balanceResult = await pool.query(
      'SELECT swept_cash FROM cash_balances WHERE user_id = $1',
      [userId]
    );
    
    if (balanceResult.rows.length === 0) {
      throw new Error('User not found');
    }
    
    const sweptCash = parseFloat(balanceResult.rows[0].swept_cash);
    
    if (sweptCash < amount) {
      throw new Error(`Insufficient swept cash. Need $${amount}, have $${sweptCash}`);
    }
    
    // Record reverse sweep
    await pool.query(
      `INSERT INTO cash_sweeps (user_id, sweep_type, amount)
       VALUES ($1, 'sweep_in', $2)`,
      [userId, amount]
    );
    
    // Update balances
    await pool.query(
      `UPDATE cash_balances 
       SET available_cash = available_cash + $1,
           swept_cash = swept_cash - $1
       WHERE user_id = $2`,
      [amount, userId]
    );
    
    // Log transaction
    await logTransaction(pool, userId, 'sweep_in', amount, 
      'Cash returned from savings for trade');
    
    console.log(`✅ Reversed sweep: $${amount.toFixed(2)} for user ${userId}`);
    
    return { success: true, amountReversed: amount };
    
  } catch (error) {
    console.error(`❌ Error reversing sweep:`, error);
    throw error;
  }
}

// ============================================================================
// INTEREST CALCULATION FUNCTIONS
// ============================================================================

/**
 * Calculate daily interest for all users (runs at midnight)
 */
async function calculateDailyInterest(pool) {
  console.log('💰 Calculating daily interest...');
  
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get all users with swept cash
    const usersResult = await pool.query(`
      SELECT user_id, swept_cash 
      FROM cash_balances 
      WHERE swept_cash > 0
    `);
    
    let totalInterest = 0;
    let userCount = 0;
    
    for (const user of usersResult.rows) {
      const sweptCash = parseFloat(user.swept_cash);
      
      // Tiered interest rates
      let annualRate;
      if (sweptCash < 1000) {
        annualRate = 0.005;        // 0.5% for balances under $1k
      } else if (sweptCash < 10000) {
        annualRate = 0.030;        // 3.0% for $1k-$10k
      } else if (sweptCash < 100000) {
        annualRate = 0.045;        // 4.5% for $10k-$100k
      } else {
        annualRate = 0.050;        // 5.0% for $100k+
      }
      
      // Calculate daily interest
      const dailyInterest = (sweptCash * annualRate) / 365;
      
      // Record accrual
      await pool.query(
        `INSERT INTO interest_accruals (
          user_id, accrual_date, idle_cash_balance,
          annual_rate, daily_interest
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, accrual_date) DO NOTHING`,
        [user.user_id, today, sweptCash, annualRate, dailyInterest]
      );
      
      totalInterest += dailyInterest;
      userCount++;
    }
    
    console.log(`✅ Interest calculated: ${userCount} users, $${totalInterest.toFixed(4)} total`);
    
    return { success: true, userCount, totalInterest };
    
  } catch (error) {
    console.error('❌ Error calculating daily interest:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Pay monthly interest (runs on 1st of month at 1 AM)
 */
async function payMonthlyInterest(pool) {
  console.log('💸 Processing monthly interest payouts...');
  
  try {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const lastMonthStr = lastMonth.toISOString().split('T')[0];
    const thisMonthStr = thisMonth.toISOString().split('T')[0];
    
    // Get uncredited interest for each user
    const interestResult = await pool.query(`
      SELECT user_id, SUM(daily_interest) as total_interest
      FROM interest_accruals
      WHERE accrual_date >= $1
        AND accrual_date < $2
        AND credited = false
      GROUP BY user_id
    `, [lastMonthStr, thisMonthStr]);
    
    let totalPaid = 0;
    let userCount = 0;
    
    for (const userInterest of interestResult.rows) {
      const userId = userInterest.user_id;
      const interestAmount = parseFloat(userInterest.total_interest);
      
      // Credit to account
      await pool.query(
        `UPDATE cash_balances
         SET total_cash = total_cash + $1,
             available_cash = available_cash + $1
         WHERE user_id = $2`,
        [interestAmount, userId]
      );
      
      // Log transaction
      const monthName = lastMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      await logTransaction(pool, userId, 'interest', interestAmount,
        `Interest earned for ${monthName}`);
      
      // Mark as credited
      await pool.query(
        `UPDATE interest_accruals
         SET credited = true, credited_at = NOW()
         WHERE user_id = $1
           AND accrual_date >= $2
           AND accrual_date < $3
           AND credited = false`,
        [userId, lastMonthStr, thisMonthStr]
      );
      
      totalPaid += interestAmount;
      userCount++;
      
      console.log(`✅ Paid $${interestAmount.toFixed(2)} interest to user ${userId}`);
    }
    
    console.log(`✅ Monthly payout complete: ${userCount} users, $${totalPaid.toFixed(2)} total`);
    
    return { success: true, userCount, totalPaid };
    
  } catch (error) {
    console.error('❌ Error paying monthly interest:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function logTransaction(pool, userId, type, amount, description) {
  try {
    // Get current balance
    const balanceResult = await pool.query(
      'SELECT total_cash FROM cash_balances WHERE user_id = $1',
      [userId]
    );
    
    const balanceAfter = balanceResult.rows.length > 0 
      ? parseFloat(balanceResult.rows[0].total_cash) 
      : 0;
    
    // Insert transaction
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, balance_after, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, amount, balanceAfter, description]
    );
  } catch (error) {
    console.error('Error logging transaction:', error);
  }
}

/**
 * Get cash management stats
 */
async function getCashManagementStats(pool) {
  try {
    // Total swept cash across all users
    const sweptResult = await pool.query(
      'SELECT SUM(swept_cash) as total_swept FROM cash_balances'
    );
    
    // Total interest accrued this month
    const thisMonth = new Date().toISOString().slice(0, 7) + '-01';
    const interestResult = await pool.query(
      `SELECT SUM(daily_interest) as total_interest 
       FROM interest_accruals 
       WHERE accrual_date >= $1 AND credited = false`,
      [thisMonth]
    );
    
    // Platform revenue (interest margin)
    const revenueResult = await pool.query(
      `SELECT SUM(amount * platform_margin) as revenue
       FROM cash_sweeps
       WHERE sweep_type = 'sweep_out'`
    );
    
    const totalSwept = parseFloat(sweptResult.rows[0].total_swept || 0);
    const monthlyInterest = parseFloat(interestResult.rows[0].total_interest || 0);
    const platformRevenue = parseFloat(revenueResult.rows[0].revenue || 0);
    
    // Calculate estimated monthly revenue
    const estimatedMonthlyRevenue = (totalSwept * SWEEP_CONFIG.platformMargin) / 12;
    
    return {
      totalSweptCash: totalSwept,
      monthlyInterestAccrued: monthlyInterest,
      platformRevenue: platformRevenue,
      estimatedMonthlyRevenue: estimatedMonthlyRevenue,
      userYieldRate: SWEEP_CONFIG.userRate * 100,
      platformMargin: SWEEP_CONFIG.platformMargin * 100,
    };
  } catch (error) {
    console.error('Error getting cash management stats:', error);
    return null;
  }
}

// ============================================================================
// CRON JOBS
// ============================================================================

function setupCronJobs(pool) {
  console.log('⏰ Setting up cron jobs...');
  
  // Hourly cash sweep (every hour at :00)
  cron.schedule('0 * * * *', async () => {
    console.log(`\n⏰ [${new Date().toLocaleString()}] Running hourly cash sweep...`);
    await sweepAllUsers(pool);
  });
  
  // Daily interest calculation (midnight every day)
  cron.schedule('0 0 * * *', async () => {
    console.log(`\n⏰ [${new Date().toLocaleString()}] Calculating daily interest...`);
    await calculateDailyInterest(pool);
  });
  
  // Monthly interest payout (1st of month at 1 AM)
  cron.schedule('0 1 1 * *', async () => {
    console.log(`\n⏰ [${new Date().toLocaleString()}] Processing monthly interest payout...`);
    await payMonthlyInterest(pool);
  });
  
  console.log('✅ Cron jobs scheduled:');
  console.log('   • Hourly sweep: Every hour at :00');
  console.log('   • Daily interest: Every day at midnight');
  console.log('   • Monthly payout: 1st of month at 1:00 AM');
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  sweepUserCash,
  sweepAllUsers,
  reverseSweep,
  calculateDailyInterest,
  payMonthlyInterest,
  getCashManagementStats,
  setupCronJobs,
  SWEEP_CONFIG,
};
