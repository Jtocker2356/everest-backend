// ============================================================================
// PHASE 1: USER PROFILE & SETTINGS ROUTES
// Add this to your server.js after the existing user routes
// ============================================================================

/**
 * GET /api/users/:userId
 * Get public user profile
 */
app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await pool.query(
      `SELECT 
        u.public_id,
        u.username,
        u.display_name,
        u.avatar_url,
        u.bio,
        u.is_public,
        u.is_verified,
        u.created_at,
        s.show_portfolio_value,
        s.show_positions,
        s.show_returns
       FROM users u
       LEFT JOIN user_settings s ON u.id = s.user_id
       WHERE u.public_id = $1 AND u.deleted_at IS NULL`,
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const user = result.rows[0];
    
    // Check if profile is public
    if (!user.is_public) {
      // TODO: Check if requesting user is following this user
      return res.status(403).json({ 
        success: false, 
        error: 'This profile is private' 
      });
    }
    
    res.json({ 
      success: true, 
      user: {
        userId: user.public_id,
        username: user.username,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        bio: user.bio,
        isVerified: user.is_verified,
        memberSince: user.created_at,
        privacy: {
          showPortfolioValue: user.show_portfolio_value,
          showPositions: user.show_positions,
          showReturns: user.show_returns
        }
      }
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/users/me/profile
 * Get current user's complete profile
 */
app.get('/api/users/me/profile', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        u.public_id,
        u.email,
        u.username,
        u.display_name,
        u.avatar_url,
        u.bio,
        u.is_public,
        u.is_verified,
        u.profile_completed,
        u.onboarding_completed,
        u.created_at
       FROM users u
       WHERE u.id = $1`,
      [req.user.id]
    );
    
    res.json({ 
      success: true, 
      profile: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching own profile:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/users/me/profile
 * Update current user's profile
 */
app.put('/api/users/me/profile', authenticateUser, async (req, res) => {
  try {
    const { username, displayName, avatarUrl, bio, isPublic } = req.body;
    
    // Validate username format if provided
    if (username) {
      const usernameRegex = /^[a-z0-9_]{3,50}$/;
      if (!usernameRegex.test(username)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Username must be 3-50 characters, lowercase letters, numbers, and underscores only' 
        });
      }
      
      // Check if username is taken
      const existingUser = await pool.query(
        'SELECT id FROM users WHERE username = $1 AND id != $2',
        [username, req.user.id]
      );
      
      if (existingUser.rows.length > 0) {
        return res.status(409).json({ 
          success: false, 
          error: 'Username already taken' 
        });
      }
    }
    
    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (username !== undefined) {
      updates.push(`username = $${paramCount}`);
      values.push(username);
      paramCount++;
    }
    if (displayName !== undefined) {
      updates.push(`display_name = $${paramCount}`);
      values.push(displayName);
      paramCount++;
    }
    if (avatarUrl !== undefined) {
      updates.push(`avatar_url = $${paramCount}`);
      values.push(avatarUrl);
      paramCount++;
    }
    if (bio !== undefined) {
      updates.push(`bio = $${paramCount}`);
      values.push(bio);
      paramCount++;
    }
    if (isPublic !== undefined) {
      updates.push(`is_public = $${paramCount}`);
      values.push(isPublic);
      paramCount++;
    }
    
    // Mark profile as completed if username is set
    if (username) {
      updates.push(`profile_completed = true`);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No fields to update' 
      });
    }
    
    values.push(req.user.id);
    
    const result = await pool.query(
      `UPDATE users 
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramCount}
       RETURNING public_id, username, display_name, avatar_url, bio, is_public, profile_completed`,
      values
    );
    
    console.log(`✅ Profile updated for user: ${req.user.email}`);
    
    res.json({ 
      success: true, 
      profile: result.rows[0],
      message: 'Profile updated successfully'
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    
    // Handle unique constraint violation
    if (error.code === '23505') {
      return res.status(409).json({ 
        success: false, 
        error: 'Username already taken' 
      });
    }
    
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/users/me/settings
 * Get current user's settings
 */
app.get('/api/users/me/settings', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM user_settings WHERE user_id = $1`,
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      // Create default settings if they don't exist
      const newSettings = await pool.query(
        `INSERT INTO user_settings (user_id) VALUES ($1) RETURNING *`,
        [req.user.id]
      );
      return res.json({ 
        success: true, 
        settings: newSettings.rows[0]
      });
    }
    
    res.json({ 
      success: true, 
      settings: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/users/me/settings
 * Update current user's settings
 */
app.put('/api/users/me/settings', authenticateUser, async (req, res) => {
  try {
    const {
      tradeVisibility,
      visibilityDelayMinutes,
      allowFollowRequests,
      showPortfolioValue,
      showPositions,
      showReturns,
      notificationsEnabled,
      emailNotifications,
      pushNotifications,
      notifyOnFollow,
      notifyOnComment,
      notifyOnMention,
      defaultOrderType,
      requireTradeConfirmation,
      enableFractionalShares,
      theme,
      currency,
      timezone
    } = req.body;
    
    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    const fieldMap = {
      tradeVisibility: 'trade_visibility',
      visibilityDelayMinutes: 'visibility_delay_minutes',
      allowFollowRequests: 'allow_follow_requests',
      showPortfolioValue: 'show_portfolio_value',
      showPositions: 'show_positions',
      showReturns: 'show_returns',
      notificationsEnabled: 'notifications_enabled',
      emailNotifications: 'email_notifications',
      pushNotifications: 'push_notifications',
      notifyOnFollow: 'notify_on_follow',
      notifyOnComment: 'notify_on_comment',
      notifyOnMention: 'notify_on_mention',
      defaultOrderType: 'default_order_type',
      requireTradeConfirmation: 'require_trade_confirmation',
      enableFractionalShares: 'enable_fractional_shares',
      theme: 'theme',
      currency: 'currency',
      timezone: 'timezone'
    };
    
    Object.entries(fieldMap).forEach(([jsField, dbField]) => {
      if (req.body[jsField] !== undefined) {
        updates.push(`${dbField} = $${paramCount}`);
        values.push(req.body[jsField]);
        paramCount++;
      }
    });
    
    if (updates.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No fields to update' 
      });
    }
    
    values.push(req.user.id);
    
    const result = await pool.query(
      `UPDATE user_settings 
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE user_id = $${paramCount}
       RETURNING *`,
      values
    );
    
    console.log(`✅ Settings updated for user: ${req.user.email}`);
    
    res.json({ 
      success: true, 
      settings: result.rows[0],
      message: 'Settings updated successfully'
    });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/users/check-username
 * Check if username is available (public endpoint)
 */
app.post('/api/users/check-username', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ 
        success: false, 
        error: 'Username is required' 
      });
    }
    
    // Validate format
    const usernameRegex = /^[a-z0-9_]{3,50}$/;
    if (!usernameRegex.test(username)) {
      return res.json({ 
        success: true,
        available: false,
        error: 'Username must be 3-50 characters, lowercase letters, numbers, and underscores only'
      });
    }
    
    // Check if taken
    const result = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );
    
    res.json({ 
      success: true,
      available: result.rows.length === 0,
      username: username
    });
  } catch (error) {
    console.error('Error checking username:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

console.log('✅ Phase 1 routes installed');
