// server.js - Everest Trading Platform Backend v3.0
// Production-Ready with Social Features & Role-Based Access Control
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const admin = require('firebase-admin');
const Alpaca = require('@alpacahq/alpaca-trade-api');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cashManagement = require('./cashManagement');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const TradeSyncService = require('./TradeSyncService');
const NotificationService = require('./NotificationService');
const AlpacaBrokerService = require('./AlpacaBrokerService');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const ENV = process.env.NODE_ENV || 'development';

// ============================================================================
// MIDDLEWARE SETUP
// ============================================================================

// Security headers
app.use(helmet());

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
    if (allowedOrigins.includes('*') || !origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
};
app.use(cors(corsOptions));

// Rate limiting (more aggressive in production)
const limiter = rateLimit({
  windowMs: ENV === 'production' ? 10 * 60 * 1000 : 15 * 60 * 1000, // 10 or 15 min
  max: ENV === 'production' ? 50 : 100, // 50 or 100 requests
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json());

// Request logging (dev only)
if (ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });
}

// ============================================================================
// INITIALIZE SERVICES
// ============================================================================

// Firebase Admin
let firebaseInitialized = false;
try {
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
    firebaseInitialized = true;
    console.log('✅ Firebase Admin initialized');
  } else {
    console.log('⚠️  Firebase not configured - authentication disabled');
  }
} catch (error) {
  console.error('⚠️  Firebase initialization error:', error.message);
}

// PostgreSQL Database
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'everest_trading',
  password: process.env.DB_PASSWORD || 'postgres',
  port: process.env.DB_PORT || 5432,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  process.exit(-1);
});

// Initialize notification service
const notificationService = new NotificationService(pool);

// Initialize brokerage service
const brokerService = new AlpacaBrokerService(pool);

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  } else {
    console.log('✅ Database connected:', res.rows[0].now);
  }
});

// Alpaca Trading API
let alpacaClient = null;
try {
  if (process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
    alpacaClient = new Alpaca({
      keyId: process.env.ALPACA_API_KEY,
      secretKey: process.env.ALPACA_SECRET_KEY,
      paper: process.env.ALPACA_PAPER !== 'false',
      baseUrl: process.env.ALPACA_PAPER !== 'false' 
        ? 'https://paper-api.alpaca.markets'
        : 'https://api.alpaca.markets'
    });
    console.log('✅ Alpaca API initialized (Paper:', process.env.ALPACA_PAPER !== 'false', ')');
  } else {
    console.log('⚠️  Alpaca not configured - trading disabled');
  }
} catch (error) {
  console.error('⚠️  Alpaca initialization error:', error.message);
}
// PHASE 2: Initialize Trade Sync Service
let tradeSyncService = null;
if (alpacaClient && pool) {
  tradeSyncService = new TradeSyncService(pool, alpacaClient);
  tradeSyncService.startAutoSync();
}

// Plaid API
let plaidClient = null;
try {
  if (process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET) {
    const plaidConfig = new Configuration({
      basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
          'PLAID-SECRET': process.env.PLAID_SECRET,
        },
      },
    });
    plaidClient = new PlaidApi(plaidConfig);
    console.log('✅ Plaid API initialized (Environment:', process.env.PLAID_ENV || 'sandbox', ')');
  } else {
    console.log('⚠️  Plaid not configured - banking disabled');
  }
} catch (error) {
  console.error('⚠️  Plaid initialization error:', error.message);
}

// Market Data API
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
if (!FINNHUB_API_KEY) {
  console.error('❌ FINNHUB_API_KEY not set in .env');
}

// ============================================================================
// FILE UPLOAD SETUP
// ============================================================================

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'public', 'uploads', 'avatars');
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================

/**
 * Firebase-Only Authentication (for registration)
 * Only verifies Firebase token - does NOT check database
 */
async function authenticateFirebase(req, res, next) {
  if (!firebaseInitialized) {
    console.warn('⚠️  Auth skipped - Firebase not configured');
    req.firebaseUser = { uid: 'dev-user-' + Date.now(), email: 'dev@test.com' };
    return next();
  }

  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      success: false, 
      error: 'No authorization token provided' 
    });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.firebaseUser = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified
    };
    next();
  } catch (error) {
    console.error('Firebase auth error:', error);
    return res.status(401).json({ 
      success: false, 
      error: 'Invalid token' 
    });
  }
}

/**
 * Authenticate user with Firebase token
 * Adds req.user with: { id, publicId, email, role, status }
 */
async function authenticateUser(req, res, next) {
  // Skip auth if Firebase not initialized (dev mode)
  if (!firebaseInitialized) {
    console.warn('⚠️  Auth skipped - Firebase not configured');
    // Use test user for dev
    const testUser = await pool.query(
      `SELECT id, public_id, email, role, account_status, kyc_status 
       FROM users WHERE email = 'test@everest-trading.dev' LIMIT 1`
    );
    if (testUser.rows.length > 0) {
      req.user = {
        id: testUser.rows[0].id,
        publicId: testUser.rows[0].public_id,
        email: testUser.rows[0].email,
        role: testUser.rows[0].role,
        accountStatus: testUser.rows[0].account_status,
        kycStatus: testUser.rows[0].kyc_status
      };
    }
    return next();
  }

  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      success: false, 
      error: 'No authorization token provided' 
    });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    // Verify Firebase token
    const decodedToken = await admin.auth().verifyIdToken(token);
    const firebaseUid = decodedToken.uid;
    
    // Get user from database
    const userResult = await pool.query(
      `SELECT id, public_id, email, role, account_status, kyc_status,
              locked_until, deleted_at
       FROM users 
       WHERE firebase_uid = $1`,
      [firebaseUid]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found. Please register first.' 
      });
    }
    
    const user = userResult.rows[0];
    
    // Check if account is deleted
    if (user.deleted_at) {
      return res.status(403).json({ 
        success: false, 
        error: 'Account has been deleted' 
      });
    }
    
    // Check if account is locked
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ 
        success: false, 
        error: 'Account is temporarily locked. Please try again later.',
        lockedUntil: user.locked_until
      });
    }
    
    // Check account status
    if (user.account_status === 'suspended') {
      return res.status(403).json({ 
        success: false, 
        error: 'Account is suspended. Please contact support.' 
      });
    }
    
    if (user.account_status === 'closed') {
      return res.status(403).json({ 
        success: false, 
        error: 'Account is closed.' 
      });
    }
    
    // Record login
    const ip = req.ip || req.connection.remoteAddress;
    await pool.query(
      'SELECT record_login($1, $2, $3)',
      [user.id, ip, true]
    );
    
    // Attach user to request
    req.user = {
      id: user.id,
      publicId: user.public_id,
      email: user.email,
      role: user.role,
      accountStatus: user.account_status,
      kycStatus: user.kyc_status
    };
    
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    
    // Handle specific Firebase errors
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ 
        success: false, 
        error: 'Token expired. Please sign in again.' 
      });
    }
    
    if (error.code === 'auth/argument-error') {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid token format' 
      });
    }
    
    return res.status(401).json({ 
      success: false, 
      error: 'Authentication failed' 
    });
  }
}

/**
 * Require specific role(s)
 * Usage: requireRole('admin') or requireRole(['admin', 'verified'])
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authentication required' 
      });
    }
    
    const roles = allowedRoles.flat();
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        error: `Access denied. Required role: ${roles.join(' or ')}`,
        currentRole: req.user.role
      });
    }
    
    next();
  };
}

/**
 * Require KYC approval for sensitive operations
 */
function requireKYC(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      error: 'Authentication required' 
    });
  }
  
  if (req.user.kycStatus !== 'approved') {
    return res.status(403).json({ 
      success: false, 
      error: 'KYC verification required',
      kycStatus: req.user.kycStatus
    });
  }
  
  next();
}

/**
 * Optional auth (allows unauthenticated requests)
 */
async function optionalAuth(req, res, next) {
  if (!req.headers.authorization) {
    return next();
  }
  return authenticateUser(req, res, next);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function getFinnhubQuote(symbol) {
  try {
    const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`;
    const response = await axios.get(quoteUrl, { timeout: 5000 });
    
    const current = response.data.c;
    const previousClose = response.data.pc;
    const change = current - previousClose;
    const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;
    
    return {
      symbol,
      price: current,
      change,
      changePercent,
      volume: 0,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error(`Error fetching ${symbol}:`, error.message);
    return null;
  }
}

// ============================================================================
// PUBLIC ROUTES
// ============================================================================

app.get('/', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Everest Trading Platform API',
    version: '3.0.0',
    environment: ENV,
    status: 'operational',
    features: {
      authentication: firebaseInitialized,
      trading: alpacaClient !== null,
      banking: plaidClient !== null,
      cashManagement: true,
      realTimeQuotes: !!FINNHUB_API_KEY,
      socialFeatures: true
    }
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'healthy',
      environment: ENV,
      database: 'connected',
      timestamp: new Date().toISOString(),
      services: {
        firebase: firebaseInitialized,
        alpaca: alpacaClient !== null,
        plaid: plaidClient !== null,
        market_data: !!FINNHUB_API_KEY
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

// ============================================================================
// ADMIN DASHBOARD
// ============================================================================

// Serve admin dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

// Admin stats endpoint
app.get('/api/admin/stats', async (req, res) => {
  try {
    const [users, trades] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM users WHERE deleted_at IS NULL'),
      pool.query('SELECT COUNT(*) as total FROM trades')
    ]);
    
    res.json({
      success: true,
      users: {
        total: parseInt(users.rows[0].total)
      },
      trades: {
        total: parseInt(trades.rows[0].total)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// USER MANAGEMENT ROUTES
// ============================================================================

/**
 * POST /api/users/register
 * Register new user (authenticated with Firebase ONLY - user doesn't exist in DB yet)
 */
app.post('/api/users/register', authenticateFirebase, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { email, firstName, lastName, phoneNumber } = req.body;
    
    // Get Firebase info from middleware (already verified)
    const firebaseUid = req.firebaseUser.uid;
    const firebaseEmail = req.firebaseUser.email || email;
    
    // Check if user already exists
    const existingUser = await client.query(
      'SELECT id, public_id FROM users WHERE firebase_uid = $1',
      [firebaseUid]
    );
    
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.json({ 
        success: true, 
        userId: existingUser.rows[0].public_id,
        message: 'User already registered'
      });
    }
    
    // Create user
    const userResult = await client.query(
      `INSERT INTO users (
        firebase_uid, email, first_name, last_name, phone_number,
        role, account_status, kyc_status, email_verified
      )
      VALUES ($1, $2, $3, $4, $5, 'user', 'pending', 'not_started', $6)
      RETURNING id, public_id`,
      [
        firebaseUid, 
        firebaseEmail, 
        firstName, 
        lastName, 
        phoneNumber,
        req.firebaseUser.emailVerified || false
      ]
    );
    
    const userId = userResult.rows[0].id;
    const publicId = userResult.rows[0].public_id;
    
    // Initialize cash balance
    await client.query(
      `INSERT INTO cash_balances (
        user_id, total_cash, available_cash, buying_power, sweep_enabled, sweep_threshold
      )
      VALUES ($1, 0, 0, 0, true, 100.00)`,
      [userId]
    );
    
    await client.query('COMMIT');
    
    console.log(`✅ New user registered: ${email} (${publicId})`);
    
    res.json({ 
      success: true, 
      userId: publicId,
      message: 'User registered successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error registering user:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/users/me
 * Get current user profile
 */
app.get('/api/users/me', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.public_id, u.email, u.first_name, u.last_name, u.phone_number,
              u.role, u.account_status, u.kyc_status, u.email_verified, u.phone_verified,
              u.created_at, u.last_login_at,
              cb.total_cash, cb.available_cash, cb.buying_power, 
              cb.swept_cash, cb.sweep_enabled, cb.sweep_threshold
       FROM users u
       LEFT JOIN cash_balances cb ON u.id = cb.user_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/users/me
 * Update current user profile
 */
app.put('/api/users/me', authenticateUser, async (req, res) => {
  try {
    const { firstName, lastName, phoneNumber } = req.body;
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (firstName) {
      updates.push(`first_name = $${paramCount++}`);
      values.push(firstName);
    }
    
    if (lastName) {
      updates.push(`last_name = $${paramCount++}`);
      values.push(lastName);
    }
    
    if (phoneNumber) {
      updates.push(`phone_number = $${paramCount++}`);
      values.push(phoneNumber);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No updates provided' });
    }
    
    values.push(req.user.id);
    
    await pool.query(
      `UPDATE users 
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramCount}`,
      values
    );
    
    res.json({ success: true, message: 'Profile updated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// PHASE 1: USER PROFILE & SETTINGS ROUTES
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
        u.follower_count,
        u.following_count,
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
        followerCount: user.follower_count || 0,
        followingCount: user.following_count || 0,
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
        u.follower_count,
        u.following_count,
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

// ============================================================================
// AVATAR/IMAGE UPLOAD ROUTES
// ============================================================================

/**
 * POST /api/users/me/avatar
 * Upload profile picture
 */
app.post('/api/users/me/avatar', authenticateUser, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const userId = req.user.publicId;
    const filename = `${userId}-${Date.now()}.jpg`;
    const filepath = path.join(uploadsDir, filename);

    // Resize and optimize image using sharp
    await sharp(req.file.buffer)
      .resize(400, 400, {
        fit: 'cover',
        position: 'center',
      })
      .jpeg({ quality: 85 })
      .toFile(filepath);

    // Generate public URL - use request host so it works regardless of IP
    const host = req.headers['x-forwarded-host'] || req.headers.host || '10.200.139.195:3000';
    const avatarUrl = `http://${host}/uploads/avatars/${filename}`;

    // Get old avatar before updating
    const oldAvatarResult = await pool.query(
      'SELECT avatar_url FROM users WHERE public_id = $1',
      [userId]
    );

    // Update user's avatar_url in database
    await pool.query(
      'UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE public_id = $2',
      [avatarUrl, userId]
    );

    // Delete old avatar file if it exists
    if (oldAvatarResult.rows[0]?.avatar_url) {
      const oldUrl = oldAvatarResult.rows[0].avatar_url;
      if (oldUrl.includes('/uploads/avatars/') && oldUrl !== avatarUrl) {
        const oldFilename = path.basename(oldUrl);
        const oldFilepath = path.join(uploadsDir, oldFilename);
        try {
          await fs.unlink(oldFilepath);
          console.log(`✅ Deleted old avatar: ${oldFilename}`);
        } catch (err) {
          // File might not exist, ignore error
        }
      }
    }

    console.log(`✅ Avatar uploaded for user ${userId}: ${avatarUrl}`);

    res.json({
      success: true,
      avatar_url: avatarUrl,
    });
  } catch (error) {
    console.error('❌ Avatar upload error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to upload avatar',
      details: error.message 
    });
  }
});

/**
 * DELETE /api/users/me/avatar
 * Remove profile picture
 */
app.delete('/api/users/me/avatar', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.publicId;

    // Get current avatar URL
    const result = await pool.query(
      'SELECT avatar_url FROM users WHERE public_id = $1',
      [userId]
    );

    const avatarUrl = result.rows[0]?.avatar_url;

    // Delete file if it exists on our server
    if (avatarUrl && avatarUrl.includes('/uploads/avatars/')) {
      const filename = path.basename(avatarUrl);
      const filepath = path.join(uploadsDir, filename);
      try {
        await fs.unlink(filepath);
        console.log(`✅ Deleted avatar file: ${filename}`);
      } catch (err) {
        // File might not exist, continue anyway
        console.log(`⚠️ Could not delete file: ${filename}`);
      }
    }

    // Remove avatar_url from database
    await pool.query(
      'UPDATE users SET avatar_url = NULL, updated_at = NOW() WHERE public_id = $1',
      [userId]
    );

    console.log(`✅ Avatar removed for user ${userId}`);

    res.json({
      success: true,
      message: 'Avatar removed successfully',
    });
  } catch (error) {
    console.error('❌ Avatar removal error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to remove avatar' 
    });
  }
});

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// ============================================================================
// PHASE 2: SOCIAL FEATURES - Follow System & User Search
// ============================================================================

/**
 * GET /api/users/search
 * Search for users by username or display name
 */
app.get('/api/users/search', authenticateUser, async (req, res) => {
  try {
    const { q } = req.query;
    const currentUserId = req.user.publicId;

    if (!q || q.trim().length === 0) {
      return res.json({ users: [] });
    }

    const searchQuery = q.trim().toLowerCase();

    // Search by username or display name
    // Only return public profiles or users who follow the searcher
    const result = await pool.query(`
      SELECT 
        u.public_id,
        u.username,
        u.display_name,
        u.bio,
        u.avatar_url,
        u.is_public,
        u.follower_count,
        u.following_count
      FROM users u
      WHERE 
        u.public_id != $1
        AND (
          LOWER(u.username) LIKE $2
          OR LOWER(u.display_name) LIKE $2
        )
        AND (
          u.is_public = true
          OR EXISTS (
            SELECT 1 FROM user_follows 
            WHERE follower_id = u.public_id 
            AND following_id = $1
          )
        )
      ORDER BY 
        CASE 
          WHEN LOWER(u.username) = $3 THEN 0
          WHEN LOWER(u.username) LIKE $4 THEN 1
          ELSE 2
        END,
        u.follower_count DESC
      LIMIT 50
    `, [currentUserId, `%${searchQuery}%`, searchQuery, `${searchQuery}%`]);

    res.json({ users: result.rows });
  } catch (error) {
    console.error('❌ Search error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

/**
 * POST /api/users/:publicId/follow
 * Follow a user
 */
app.post('/api/users/:publicId/follow', authenticateUser, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { publicId } = req.params;
    const followerId = req.user.publicId;

    // Can't follow yourself
    if (followerId === publicId) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    // Check if user exists
    const userCheck = await client.query(
      'SELECT public_id, is_public FROM users WHERE public_id = $1',
      [publicId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await client.query('BEGIN');

    // Insert follow relationship (if not exists)
    await client.query(`
      INSERT INTO user_follows (follower_id, following_id)
      VALUES ($1, $2)
      ON CONFLICT (follower_id, following_id) DO NOTHING
    `, [followerId, publicId]);

    await client.query('COMMIT');

    console.log(`✅ User ${followerId} followed ${publicId}`);
    
    res.json({ 
      success: true,
      message: 'Successfully followed user'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Follow error:', error);
    res.status(500).json({ error: 'Failed to follow user' });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/users/:publicId/follow
 * Unfollow a user
 */
app.delete('/api/users/:publicId/follow', authenticateUser, async (req, res) => {
  try {
    const { publicId } = req.params;
    const followerId = req.user.publicId;

    await pool.query(`
      DELETE FROM user_follows
      WHERE follower_id = $1 AND following_id = $2
    `, [followerId, publicId]);

    console.log(`✅ User ${followerId} unfollowed ${publicId}`);
    
    res.json({ 
      success: true,
      message: 'Successfully unfollowed user'
    });
  } catch (error) {
    console.error('❌ Unfollow error:', error);
    res.status(500).json({ error: 'Failed to unfollow user' });
  }
});

/**
 * GET /api/users/:publicId/followers
 * Get a user's followers list
 */
app.get('/api/users/:publicId/followers', authenticateUser, async (req, res) => {
  try {
    const { publicId } = req.params;
    const currentUserId = req.user.publicId;

    // Check if we can view this user's followers
    const userCheck = await pool.query(
      'SELECT is_public FROM users WHERE public_id = $1',
      [publicId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isPublic = userCheck.rows[0].is_public;
    const isOwnProfile = publicId === currentUserId;

    if (!isPublic && !isOwnProfile) {
      return res.status(403).json({ error: 'This profile is private' });
    }

    // Get followers
    const result = await pool.query(`
      SELECT 
        u.public_id,
        u.username,
        u.display_name,
        u.bio,
        u.avatar_url,
        u.is_public
      FROM user_follows uf
      JOIN users u ON uf.follower_id = u.public_id
      WHERE uf.following_id = $1
      ORDER BY uf.created_at DESC
    `, [publicId]);

    res.json({ followers: result.rows });
  } catch (error) {
    console.error('❌ Get followers error:', error);
    res.status(500).json({ error: 'Failed to get followers' });
  }
});

/**
 * GET /api/users/:publicId/following
 * Get a user's following list
 */
app.get('/api/users/:publicId/following', authenticateUser, async (req, res) => {
  try {
    const { publicId } = req.params;
    const currentUserId = req.user.publicId;

    // Check if we can view this user's following
    const userCheck = await pool.query(
      'SELECT is_public FROM users WHERE public_id = $1',
      [publicId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isPublic = userCheck.rows[0].is_public;
    const isOwnProfile = publicId === currentUserId;

    if (!isPublic && !isOwnProfile) {
      return res.status(403).json({ error: 'This profile is private' });
    }

    // Get following
    const result = await pool.query(`
      SELECT 
        u.public_id,
        u.username,
        u.display_name,
        u.bio,
        u.avatar_url,
        u.is_public
      FROM user_follows uf
      JOIN users u ON uf.following_id = u.public_id
      WHERE uf.follower_id = $1
      ORDER BY uf.created_at DESC
    `, [publicId]);

    res.json({ following: result.rows });
  } catch (error) {
    console.error('❌ Get following error:', error);
    res.status(500).json({ error: 'Failed to get following' });
  }
});

/**
 * GET /api/users/me/following
 * Get current user's following list (for quick lookups)
 */
app.get('/api/users/me/following', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.publicId;

    const result = await pool.query(`
      SELECT 
        u.public_id,
        u.username,
        u.display_name,
        u.avatar_url
      FROM user_follows uf
      JOIN users u ON uf.following_id = u.public_id
      WHERE uf.follower_id = $1
      ORDER BY uf.created_at DESC
    `, [userId]);

    res.json({ following: result.rows });
  } catch (error) {
    console.error('❌ Get my following error:', error);
    res.status(500).json({ error: 'Failed to get following' });
  }
});

/**
 * GET /api/users/:publicId/is-following
 * Check if current user is following another user
 */
app.get('/api/users/:publicId/is-following', authenticateUser, async (req, res) => {
  try {
    const { publicId } = req.params;
    const followerId = req.user.publicId;

    const result = await pool.query(`
      SELECT EXISTS(
        SELECT 1 FROM user_follows
        WHERE follower_id = $1 AND following_id = $2
      ) as is_following
    `, [followerId, publicId]);

    res.json({ isFollowing: result.rows[0].is_following });
  } catch (error) {
    console.error('❌ Check following error:', error);
    res.status(500).json({ error: 'Failed to check following status' });
  }
});

// ============================================================================
// MARKET DATA ROUTES (Public or authenticated)
// ============================================================================

app.get('/api/quotes/:symbol', optionalAuth, async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const quote = await getFinnhubQuote(symbol);
    
    if (!quote) {
      return res.status(404).json({ success: false, error: 'Quote not found' });
    }
    
    res.json({ success: true, quote });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch quote' });
  }
});

app.post('/api/quotes/batch', optionalAuth, async (req, res) => {
  try {
    const { symbols } = req.body;
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid symbols array' });
    }
    
    if (symbols.length > 50) {
      return res.status(400).json({ success: false, error: 'Maximum 50 symbols per request' });
    }
    
    const quotes = {};
    for (const symbol of symbols) {
      const quote = await getFinnhubQuote(symbol);
      if (quote) quotes[symbol] = quote;
      await new Promise(r => setTimeout(r, 100));
    }
    
    res.json({ success: true, quotes, count: Object.keys(quotes).length });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch quotes' });
  }
});

// ============================================================================
// PLAID ROUTES (Authenticated users only)
// ============================================================================

app.post('/api/plaid/create-link-token', authenticateUser, async (req, res) => {
  if (!plaidClient) {
    return res.status(503).json({ success: false, error: 'Banking not available' });
  }

  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: req.user.publicId },
      client_name: 'Everest Trading',
      products: ['auth', 'transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    
    res.json({ 
      success: true,
      link_token: response.data.link_token
    });
  } catch (error) {
    console.error('Plaid link token error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/plaid/exchange-token', authenticateUser, async (req, res) => {
  if (!plaidClient) {
    return res.status(503).json({ success: false, error: 'Banking not available' });
  }

  try {
    const { public_token } = req.body;
    
    if (!public_token) {
      return res.status(400).json({ success: false, error: 'public_token required' });
    }
    
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    
    // Store access token
    await pool.query(
      `UPDATE users 
       SET plaid_access_token = $1, plaid_item_id = $2
       WHERE id = $3`,
      [response.data.access_token, response.data.item_id, req.user.id]
    );
    
    res.json({ success: true, message: 'Bank account linked' });
  } catch (error) {
    console.error('Plaid token exchange error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ALPACA TRADING ROUTES (KYC required)
// ============================================================================

app.get('/api/alpaca/account', authenticateUser, requireKYC, async (req, res) => {
  if (!alpacaClient) {
    return res.status(503).json({ success: false, error: 'Trading not available' });
  }

  try {
    const account = await alpacaClient.getAccount();
    res.json({ success: true, account });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/alpaca/orders', authenticateUser, requireKYC, async (req, res) => {
  if (!alpacaClient) {
    return res.status(503).json({ success: false, error: 'Trading not available' });
  }

  const client = await pool.connect();
  try {
    const { symbol, qty, side, type, limit_price } = req.body;
    
    if (!symbol || !qty || !side || !type) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }
    
    const orderData = {
      symbol: symbol.toUpperCase(),
      qty: parseFloat(qty),
      side,
      type,
      time_in_force: 'day'
    };
    
    if (type === 'limit' && limit_price) {
      orderData.limit_price = parseFloat(limit_price);
    }
    
    const order = await alpacaClient.createOrder(orderData);
    
    await client.query('BEGIN');
    
    await client.query(
      `INSERT INTO orders (
        user_id, alpaca_order_id, symbol, side, order_type,
        quantity, limit_price, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [req.user.id, order.id, order.symbol, order.side, order.type,
       order.qty, order.limit_price || null, order.status]
    );
    
    await client.query('COMMIT');
    
    res.json({ success: true, order });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// ============================================================================
// ADMIN ROUTES (Admin role required)
// ============================================================================

app.get('/api/admin/stats', authenticateUser, requireRole('admin'), async (req, res) => {
  try {
    const [userStats, cashStats] = await Promise.all([
      pool.query('SELECT * FROM user_stats'),
      pool.query('SELECT * FROM cash_stats')
    ]);
    
    res.json({
      success: true,
      users: userStats.rows[0],
      cash: cashStats.rows[0]
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/users', authenticateUser, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT public_id, email, first_name, last_name, role, account_status, kyc_status, created_at 
       FROM users 
       WHERE deleted_at IS NULL
       ORDER BY created_at DESC 
       LIMIT 100`
    );
    
    res.json({ success: true, users: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// ============================================================================
// PHASE 2: TRADES API ROUTES - ADD THIS BEFORE ERROR HANDLING SECTION
// ============================================================================

// Helper function to use consistent auth middleware name
const authenticateToken = authenticateUser;

// Get all trades for current user
app.get('/api/trades', authenticateToken, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM trades WHERE user_id = $1';
    const params = [req.user.publicId];
    
    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }
    
    query += ' ORDER BY opened_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      trades: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching trades:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single trade by ID
app.get('/api/trades/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM trades WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.publicId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Trade not found' });
    }
    
    res.json({
      success: true,
      trade: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching trade:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get user performance metrics
app.get('/api/trades/performance/metrics', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM trade_performance WHERE user_id = $1',
      [req.user.publicId]
    );
    
    if (result.rows.length === 0) {
      return res.json({
        success: true,
        performance: {
          total_trades: 0,
          open_positions: 0,
          closed_trades: 0,
          winning_trades: 0,
          losing_trades: 0,
          win_rate: 0,
          total_profit_loss: 0,
          avg_hold_time_hours: 0,
          best_trade_pct: 0,
          worst_trade_pct: 0
        }
      });
    }
    
    res.json({
      success: true,
      performance: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching performance:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get trade history with performance over time
app.get('/api/trades/performance/history', authenticateToken, async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    
    let daysAgo;
    switch (period) {
      case '7d': daysAgo = 7; break;
      case '30d': daysAgo = 30; break;
      case '90d': daysAgo = 90; break;
      case '365d': daysAgo = 365; break;
      case 'all': daysAgo = 36500; break;
      default: daysAgo = 30;
    }
    
    const result = await pool.query(`
      SELECT 
        DATE(closed_at) as date,
        COUNT(*) as trades_count,
        SUM(profit_loss) as daily_profit_loss,
        SUM(SUM(profit_loss)) OVER (ORDER BY DATE(closed_at)) as cumulative_profit_loss
      FROM trades
      WHERE user_id = $1 
        AND status = 'closed'
        AND closed_at >= NOW() - INTERVAL '${daysAgo} days'
      GROUP BY DATE(closed_at)
      ORDER BY date ASC
    `, [req.user.publicId]);
    
    res.json({
      success: true,
      history: result.rows,
      period: period
    });
  } catch (error) {
    console.error('Error fetching performance history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get trades by symbol
app.get('/api/trades/symbol/:symbol', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM trades WHERE user_id = $1 AND symbol = $2 ORDER BY opened_at DESC',
      [req.user.publicId, req.params.symbol.toUpperCase()]
    );
    
    res.json({
      success: true,
      trades: result.rows,
      symbol: req.params.symbol.toUpperCase()
    });
  } catch (error) {
    console.error('Error fetching trades by symbol:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual sync trigger
app.post('/api/trades/sync', authenticateToken, async (req, res) => {
  try {
    if (!tradeSyncService) {
      return res.status(503).json({ 
        success: false, 
        error: 'Trade sync service not available' 
      });
    }
    
    console.log(`🔄 Manual sync requested by user ${req.user.publicId}`);
    
    await tradeSyncService.manualSync(req.user.publicId);
    
    res.json({
      success: true,
      message: 'Trade sync completed'
    });
  } catch (error) {
    console.error('Error in manual sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update trade notes/tags
app.put('/api/trades/:id', authenticateToken, async (req, res) => {
  try {
    const { notes, tags, strategy } = req.body;
    
    const result = await pool.query(`
      UPDATE trades 
      SET notes = $1, tags = $2, strategy = $3, updated_at = NOW()
      WHERE id = $4 AND user_id = $5
      RETURNING *
    `, [notes, tags, strategy, req.params.id, req.user.publicId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Trade not found' });
    }
    
    res.json({
      success: true,
      trade: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating trade:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get leaderboard
app.get('/api/trades/leaderboard', authenticateToken, async (req, res) => {
  try {
    const { period = '30d', limit = 10 } = req.query;
    
    const result = await pool.query(`
      SELECT 
        u.public_id,
        u.username,
        u.display_name,
        u.avatar_url,
        tp.total_trades,
        tp.win_rate,
        tp.total_profit_loss,
        tp.best_trade_pct
      FROM trade_performance tp
      JOIN users u ON u.public_id = tp.user_id
      WHERE u.is_public = true
        AND tp.total_trades > 0
      ORDER BY tp.total_profit_loss DESC
      LIMIT $1
    `, [limit]);
    
    res.json({
      success: true,
      leaderboard: result.rows,
      period: period
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

console.log('✅ Phase 2: Trades routes installed');

// ============================================================================
// END OF PHASE 2 ROUTES
// ============================================================================

// ============================================================================
// PHASE 3: SOCIAL LAYER API ROUTES
// ============================================================================

app.post('/api/users/:userId/follow', authenticateUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.params;
    const followerId = req.user.publicId;
    if (followerId === userId) return res.status(400).json({ success: false, error: 'Cannot follow yourself' });
    const userCheck = await client.query('SELECT public_id, is_public FROM users WHERE public_id = $1', [userId]);
    if (userCheck.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
    const isPublicAccount = userCheck.rows[0].is_public;
    await client.query('BEGIN');
    const existingFollow = await client.query('SELECT status FROM user_follows WHERE follower_id = $1 AND following_id = $2', [followerId, userId]);
    if (existingFollow.rows.length > 0) {
      const status = existingFollow.rows[0].status;
      if (status === 'accepted') { await client.query('ROLLBACK'); return res.json({ success: true, status: 'already_following' }); }
      if (status === 'pending') { await client.query('ROLLBACK'); return res.json({ success: true, status: 'pending' }); }
    }
    const followStatus = isPublicAccount ? 'accepted' : 'pending';
    const acceptedAt = isPublicAccount ? new Date() : null;
    await client.query('INSERT INTO user_follows (follower_id, following_id, status, requested_at, accepted_at) VALUES ($1, $2, $3, NOW(), $4) ON CONFLICT (follower_id, following_id) DO UPDATE SET status = $3, requested_at = NOW(), accepted_at = $4', [followerId, userId, followStatus, acceptedAt]);
    await client.query('COMMIT');
    res.json({ success: true, status: followStatus });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally { client.release(); }
});

app.get('/api/users/me/follow-requests', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query('SELECT uf.follower_id, uf.requested_at, u.username, u.display_name, u.avatar_url, u.bio FROM user_follows uf JOIN users u ON uf.follower_id = u.public_id WHERE uf.following_id = $1 AND uf.status = \'pending\' ORDER BY uf.requested_at DESC', [req.user.publicId]);
    res.json({ success: true, requests: result.rows, count: result.rows.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/users/:userId/follow/accept', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query('UPDATE user_follows SET status = \'accepted\', accepted_at = NOW() WHERE follower_id = $1 AND following_id = $2 AND status = \'pending\' RETURNING *', [req.params.userId, req.user.publicId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Follow request not found' });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/users/:userId/follow/reject', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM user_follows WHERE follower_id = $1 AND following_id = $2 AND status = \'pending\' RETURNING *', [req.params.userId, req.user.publicId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Follow request not found' });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/users/:userId/block', authenticateUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.params;
    const blockerId = req.user.publicId;
    if (blockerId === userId) return res.status(400).json({ success: false, error: 'Cannot block yourself' });
    await client.query('BEGIN');
    await client.query('DELETE FROM user_follows WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)', [blockerId, userId]);
    await client.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [blockerId, userId]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally { client.release(); }
});

app.delete('/api/users/:userId/block', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2 RETURNING *', [req.user.publicId, req.params.userId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'User not blocked' });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/users/me/blocked', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query('SELECT ub.blocked_id, ub.created_at, u.username, u.display_name, u.avatar_url FROM user_blocks ub JOIN users u ON ub.blocked_id = u.public_id WHERE ub.blocker_id = $1 ORDER BY ub.created_at DESC', [req.user.publicId]);
    res.json({ success: true, blocked: result.rows, count: result.rows.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/feed', authenticateUser, async (req, res) => {
  try {
    const { limit = 50, offset = 0, type } = req.query;
    let typeCondition = '';
    if (type === 'opens') typeCondition = "AND fe.event_type = 'OPEN'";
    else if (type === 'closes') typeCondition = "AND fe.event_type = 'CLOSE'";
    const result = await pool.query(`SELECT fe.*, u.username, u.display_name, u.avatar_url, u.is_verified, EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = fe.actor_user_id AND status = 'accepted') as is_following FROM feed_events fe JOIN users u ON fe.actor_user_id = u.public_id WHERE fe.actor_user_id IN (SELECT following_id FROM user_follows WHERE follower_id = $1 AND status = 'accepted') AND fe.visible_after <= NOW() AND fe.is_public = true AND fe.actor_user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = $1) AND fe.actor_user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id = $1) ${typeCondition} ORDER BY fe.visible_after DESC LIMIT $2 OFFSET $3`, [req.user.publicId, limit, offset]);
    res.json({ success: true, feed: result.rows, count: result.rows.length, hasMore: result.rows.length === parseInt(limit) });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/feed/discover', authenticateUser, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await pool.query('SELECT fe.*, u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count FROM feed_events fe JOIN users u ON fe.actor_user_id = u.public_id WHERE fe.visible_after <= NOW() AND fe.is_public = true AND u.is_public = true AND fe.actor_user_id != $1 AND fe.actor_user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = $1) AND fe.actor_user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id = $1) ORDER BY u.follower_count DESC, fe.visible_after DESC LIMIT $2 OFFSET $3', [req.user.publicId, limit, offset]);
    res.json({ success: true, feed: result.rows, count: result.rows.length, hasMore: result.rows.length === parseInt(limit) });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

console.log('✅ Phase 3: Social feed routes installed');

// ============================================================================
// PHASE 4: PUBLIC TRADER PROFILES
// ============================================================================

app.get('/api/users/:userId/profile', authenticateUser, async (req, res) => {
  try {
    const { userId } = req.params;
    const viewerId = req.user.publicId;
    const blockCheck = await pool.query('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [viewerId, userId]);
    if (blockCheck.rows.length > 0) return res.status(403).json({ success: false, error: 'Cannot view this profile' });
    const profileResult = await pool.query('SELECT * FROM public_user_profiles WHERE public_id = $1', [userId]);
    if (profileResult.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
    const followResult = await pool.query('SELECT status FROM user_follows WHERE follower_id = $1 AND following_id = $2', [viewerId, userId]);
    const followStatus = followResult.rows.length > 0 ? followResult.rows[0].status : null;
    const tagsResult = await pool.query('SELECT * FROM get_user_strategy_tags($1)', [userId]);
    res.json({ success: true, profile: { ...profileResult.rows[0], is_following: followStatus === 'accepted', follow_status: followStatus, is_own_profile: viewerId === userId, strategy_tags: tagsResult.rows } });
  } catch (error) {
    console.error('❌ Get profile error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users/:userId/trades/public', authenticateUser, async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20, offset = 0 } = req.query;
    const viewerId = req.user.publicId;
    const canView = await pool.query('SELECT can_view_profile_data($1, $2, \'trades\') as can_view', [viewerId, userId]);
    if (!canView.rows[0].can_view) return res.status(403).json({ success: false, error: 'You do not have permission to view this user\'s trades', reason: 'privacy_settings' });
    const settingsResult = await pool.query('SELECT us.trade_delay_minutes, us.hide_trades FROM user_settings us JOIN users u ON u.id = us.user_id WHERE u.public_id = $1', [userId]);
    const settings = settingsResult.rows[0];
    if (settings.hide_trades && viewerId !== userId) return res.json({ success: true, trades: [], count: 0 });
    const delayMinutes = viewerId === userId ? 0 : (settings.trade_delay_minutes || 0);
    const result = await pool.query(`SELECT id, trade_id, symbol, asset_type, side, quantity, entry_price, exit_price, profit_loss, profit_loss_pct, opened_at, closed_at, status, strategy_tag FROM trades WHERE user_id = $1 AND opened_at <= NOW() - INTERVAL '${delayMinutes} minutes' ORDER BY opened_at DESC LIMIT $2 OFFSET $3`, [userId, limit, offset]);
    res.json({ success: true, trades: result.rows, count: result.rows.length, hasMore: result.rows.length === parseInt(limit) });
  } catch (error) {
    console.error('❌ Get public trades error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users/:userId/performance/public', authenticateUser, async (req, res) => {
  try {
    const { userId } = req.params;
    const viewerId = req.user.publicId;
    const canView = await pool.query('SELECT can_view_profile_data($1, $2, \'performance\') as can_view', [viewerId, userId]);
    if (!canView.rows[0].can_view) return res.status(403).json({ success: false, error: 'Performance stats are private' });
    const result = await pool.query('SELECT total_trades, win_rate, total_profit_loss, best_trade_pct, worst_trade_pct, avg_hold_time_hours FROM trade_performance WHERE user_id = $1', [userId]);
    res.json({ success: true, performance: result.rows.length > 0 ? result.rows[0] : null });
  } catch (error) {
    console.error('❌ Get public performance error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users/me/strategy-tags', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM get_user_strategy_tags($1)', [req.user.publicId]);
    res.json({ success: true, tags: result.rows });
  } catch (error) {
    console.error('❌ Get strategy tags error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/users/me/strategy-tags', authenticateUser, async (req, res) => {
  try {
    const { tag_name, color } = req.body;
    if (!tag_name || tag_name.length > 50) return res.status(400).json({ success: false, error: 'Tag name required (max 50 chars)' });
    const result = await pool.query('INSERT INTO strategy_tags (user_id, tag_name, color) VALUES ($1, $2, $3) ON CONFLICT (user_id, tag_name) DO UPDATE SET color = $3 RETURNING *', [req.user.publicId, tag_name, color || '#3b82f6']);
    res.json({ success: true, tag: result.rows[0] });
  } catch (error) {
    console.error('❌ Create strategy tag error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/users/me/strategy-tags/:tagName', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM strategy_tags WHERE user_id = $1 AND tag_name = $2 RETURNING *', [req.user.publicId, req.params.tagName]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Tag not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Delete strategy tag error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/trades/:tradeId/strategy', authenticateUser, async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { strategy_tag } = req.body;
    const tradeCheck = await pool.query('SELECT user_id FROM trades WHERE id = $1', [tradeId]);
    if (tradeCheck.rows.length === 0) return res.status(404).json({ success: false, error: 'Trade not found' });
    if (tradeCheck.rows[0].user_id !== req.user.publicId) return res.status(403).json({ success: false, error: 'Not your trade' });
    await pool.query('UPDATE trades SET strategy_tag = $1 WHERE id = $2', [strategy_tag, tradeId]);
    await pool.query('UPDATE feed_events SET strategy_tag = $1 WHERE trade_id = $2', [strategy_tag, tradeId]);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Update trade strategy error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/users/me/privacy', authenticateUser, async (req, res) => {
  try {
    const { hide_trades, trade_delay_minutes, show_performance_stats, show_trade_history, show_holdings } = req.body;
    if (trade_delay_minutes !== undefined && (trade_delay_minutes < 0 || trade_delay_minutes > 60)) {
      return res.status(400).json({ success: false, error: 'Delay must be between 0-60 minutes' });
    }
    const updates = [];
    const values = [];
    let paramCount = 1;
    if (hide_trades !== undefined) { updates.push(`hide_trades = $${paramCount++}`); values.push(hide_trades); }
    if (trade_delay_minutes !== undefined) { updates.push(`trade_delay_minutes = $${paramCount++}`); values.push(trade_delay_minutes); }
    if (show_performance_stats !== undefined) { updates.push(`show_performance_stats = $${paramCount++}`); values.push(show_performance_stats); }
    if (show_trade_history !== undefined) { updates.push(`show_trade_history = $${paramCount++}`); values.push(show_trade_history); }
    if (show_holdings !== undefined) { updates.push(`show_holdings = $${paramCount++}`); values.push(show_holdings); }
    if (updates.length === 0) return res.status(400).json({ success: false, error: 'No updates provided' });
    values.push(req.user.publicId);
    await pool.query(`UPDATE user_settings SET ${updates.join(', ')} WHERE user_id = (SELECT id FROM users WHERE public_id = $${paramCount})`, values);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Update privacy error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users/me/privacy', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query('SELECT hide_trades, trade_delay_minutes, show_performance_stats, show_trade_history, show_holdings FROM user_settings WHERE user_id = (SELECT id FROM users WHERE public_id = $1)', [req.user.publicId]);
    res.json({ success: true, privacy: result.rows[0] || { hide_trades: false, trade_delay_minutes: 0, show_performance_stats: true, show_trade_history: true, show_holdings: false } });
  } catch (error) {
    console.error('❌ Get privacy error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

console.log('✅ Phase 4: Public trader profiles routes installed');

// ============================================================================
// PHASE 5: ANTI COPY-TRADING & COMPLIANCE
// ============================================================================

// Rate limiter middleware - 30 requests/min per user per endpoint
const feedRateLimiter = async (req, res, next) => {
  try {
    const userId = req.user?.publicId;
    if (!userId) return next();
    const windowStart = new Date();
    windowStart.setSeconds(0, 0);
    const windowEnd = new Date(windowStart.getTime() + 60000);
    const endpoint = req.path.split('?')[0];
    const result = await pool.query(`
      INSERT INTO rate_limit_log (user_id, endpoint, request_count, window_start, window_end)
      VALUES ($1, $2, 1, $3, $4)
      ON CONFLICT (user_id, endpoint, window_start)
      DO UPDATE SET request_count = rate_limit_log.request_count + 1
      RETURNING request_count
    `, [userId, endpoint, windowStart, windowEnd]);
    const count = result.rows[0].request_count;
    const limit = 30;
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));
    res.setHeader('X-RateLimit-Reset', windowEnd.toISOString());
    if (count > limit) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please wait before refreshing the feed.',
        retryAfter: windowEnd.toISOString()
      });
    }
    next();
  } catch (error) {
    console.error('Rate limiter error:', error.message);
    next(); // Don't block on rate limiter failure
  }
};

// Audit logging helper
const logAudit = async (actorId, action, targetUserId = null, targetTradeId = null, metadata = {}) => {
  try {
    await pool.query(
      'SELECT log_audit_event($1, $2, $3, $4, $5)',
      [actorId, action, targetUserId, targetTradeId, JSON.stringify(metadata)]
    );
  } catch (error) {
    console.error('Audit log error:', error.message);
  }
};

// ============================================================================
// SAFE FEED ENDPOINTS (rate-limited, NO dollar amounts, NO trade sizes)
// ============================================================================

app.get('/api/feed/safe', authenticateUser, feedRateLimiter, async (req, res) => {
  try {
    const { limit = 50, offset = 0, type } = req.query;
    const userId = req.user.publicId;
    const safeLimit = Math.min(parseInt(limit), 50);
    let typeCondition = '';
    if (type === 'opens') typeCondition = "AND fe.event_type = 'OPEN'";
    else if (type === 'closes') typeCondition = "AND fe.event_type = 'CLOSE'";

    const result = await pool.query(`
      SELECT fe.id, fe.actor_user_id, fe.event_type, fe.symbol, fe.asset_type,
        fe.side, fe.return_pct, fe.strategy_tag, fe.visible_after, fe.copy_eligible,
        fe.username, fe.display_name, fe.avatar_url, fe.is_verified,
        fe.allow_copy_trading,
        EXISTS(SELECT 1 FROM copy_trade_relationships WHERE copier_user_id = $1 AND trader_user_id = fe.actor_user_id AND status = 'active') as is_copying
      FROM safe_feed_events fe
      WHERE fe.actor_user_id IN (SELECT following_id FROM user_follows WHERE follower_id = $1 AND status = 'accepted')
      AND fe.is_public = true
      AND fe.actor_user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = $1)
      AND fe.actor_user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id = $1)
      ${typeCondition}
      ORDER BY fe.visible_after DESC LIMIT $2 OFFSET $3
    `, [userId, safeLimit, offset]);

    await logAudit(userId, 'FEED_ACCESS', null, null, { count: result.rows.length, filter: type || 'all' });

    res.json({ success: true, feed: result.rows, count: result.rows.length, hasMore: result.rows.length === safeLimit });
  } catch (error) {
    console.error('❌ Safe feed error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/feed/discover/safe', authenticateUser, feedRateLimiter, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const userId = req.user.publicId;
    const safeLimit = Math.min(parseInt(limit), 50);

    const result = await pool.query(`
      SELECT fe.id, fe.actor_user_id, fe.event_type, fe.symbol, fe.asset_type,
        fe.side, fe.return_pct, fe.strategy_tag, fe.visible_after, fe.copy_eligible,
        fe.username, fe.display_name, fe.avatar_url, fe.is_verified,
        fe.allow_copy_trading, u.follower_count
      FROM safe_feed_events fe
      JOIN users u ON fe.actor_user_id = u.public_id
      WHERE fe.is_public = true AND u.is_public = true AND fe.actor_user_id != $1
      AND fe.actor_user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = $1)
      AND fe.actor_user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id = $1)
      ORDER BY u.follower_count DESC, fe.visible_after DESC LIMIT $2 OFFSET $3
    `, [userId, safeLimit, offset]);

    res.json({ success: true, feed: result.rows, count: result.rows.length, hasMore: result.rows.length === safeLimit });
  } catch (error) {
    console.error('❌ Safe discover error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// COPY TRADE SETTINGS
// ============================================================================

app.get('/api/users/me/copy-trade-settings', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM copy_trade_settings WHERE user_id = $1', [req.user.publicId]);
    res.json({ success: true, settings: result.rows[0] || { allow_copy_trading: false, copy_delay_minutes: 30, max_copiers: 0, show_copy_count: true } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/users/me/copy-trade-settings', authenticateUser, async (req, res) => {
  try {
    const { allow_copy_trading, copy_delay_minutes, max_copiers, show_copy_count } = req.body;
    const userId = req.user.publicId;

    if (copy_delay_minutes !== undefined && copy_delay_minutes < 15) {
      return res.status(400).json({ success: false, error: 'Minimum copy delay is 15 minutes to prevent front-running' });
    }

    const result = await pool.query(`
      INSERT INTO copy_trade_settings (user_id, allow_copy_trading, copy_delay_minutes, max_copiers, show_copy_count)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id) DO UPDATE SET
        allow_copy_trading = COALESCE($2, copy_trade_settings.allow_copy_trading),
        copy_delay_minutes = COALESCE($3, copy_trade_settings.copy_delay_minutes),
        max_copiers = COALESCE($4, copy_trade_settings.max_copiers),
        show_copy_count = COALESCE($5, copy_trade_settings.show_copy_count),
        updated_at = NOW()
      RETURNING *
    `, [userId, allow_copy_trading ?? false, copy_delay_minutes ?? 30, max_copiers ?? 0, show_copy_count ?? true]);

    await logAudit(userId, allow_copy_trading ? 'COPY_TRADE_OPT_IN' : 'COPY_TRADE_OPT_OUT', null, null, { settings: result.rows[0] });

    res.json({ success: true, settings: result.rows[0] });
  } catch (error) {
    console.error('❌ Copy trade settings error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// COPY TRADE RELATIONSHIPS
// ============================================================================

app.post('/api/users/:userId/copy', authenticateUser, async (req, res) => {
  try {
    const { userId } = req.params;
    const copierId = req.user.publicId;
    if (copierId === userId) return res.status(400).json({ success: false, error: 'Cannot copy yourself' });

    const canCopy = await pool.query('SELECT can_copy_trade($1, $2) as can_copy', [copierId, userId]);
    if (!canCopy.rows[0].can_copy) {
      return res.status(403).json({ success: false, error: 'Copy trading not enabled for this trader, or you do not follow them' });
    }

    await pool.query(`
      INSERT INTO copy_trade_relationships (copier_user_id, trader_user_id, status)
      VALUES ($1, $2, 'active')
      ON CONFLICT (copier_user_id, trader_user_id) DO UPDATE SET status = 'active', updated_at = NOW()
    `, [copierId, userId]);

    await logAudit(copierId, 'COPY_TRADE_START', userId);
    res.json({ success: true, message: 'Now copying this trader' });
  } catch (error) {
    console.error('❌ Copy trade error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/users/:userId/copy', authenticateUser, async (req, res) => {
  try {
    await pool.query(`
      UPDATE copy_trade_relationships SET status = 'stopped', updated_at = NOW()
      WHERE copier_user_id = $1 AND trader_user_id = $2
    `, [req.user.publicId, req.params.userId]);
    await logAudit(req.user.publicId, 'COPY_TRADE_STOP', req.params.userId);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Stop copy error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users/me/copying', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ctr.*, u.username, u.display_name, u.avatar_url, u.is_verified,
        cts.copy_delay_minutes, tp.win_rate, tp.total_trades
      FROM copy_trade_relationships ctr
      JOIN users u ON ctr.trader_user_id = u.public_id
      LEFT JOIN copy_trade_settings cts ON cts.user_id = ctr.trader_user_id
      LEFT JOIN trade_performance tp ON tp.user_id = ctr.trader_user_id
      WHERE ctr.copier_user_id = $1 AND ctr.status = 'active'
      ORDER BY ctr.created_at DESC
    `, [req.user.publicId]);
    res.json({ success: true, copying: result.rows, count: result.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users/me/copiers', authenticateUser, async (req, res) => {
  try {
    const settings = await pool.query('SELECT show_copy_count FROM copy_trade_settings WHERE user_id = $1', [req.user.publicId]);
    if (!settings.rows[0]?.show_copy_count) {
      return res.json({ success: true, copiers: [], count: 0, hidden: true });
    }
    const result = await pool.query(`
      SELECT ctr.created_at, u.username, u.display_name, u.avatar_url
      FROM copy_trade_relationships ctr
      JOIN users u ON ctr.copier_user_id = u.public_id
      WHERE ctr.trader_user_id = $1 AND ctr.status = 'active'
      ORDER BY ctr.created_at DESC
    `, [req.user.publicId]);
    res.json({ success: true, copiers: result.rows, count: result.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users/me/audit-log', authenticateUser, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await pool.query(`
      SELECT action_type, target_user_id, metadata, created_at
      FROM audit_logs WHERE actor_user_id = $1
      ORDER BY created_at DESC LIMIT $2 OFFSET $3
    `, [req.user.publicId, Math.min(parseInt(limit), 100), offset]);
    res.json({ success: true, logs: result.rows, count: result.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

console.log('✅ Phase 5: Anti copy-trading & compliance routes installed');

// ============================================================================
// PHASE 6: NOTIFICATIONS
// ============================================================================

// Register device token
app.post('/api/notifications/register', authenticateUser, async (req, res) => {
  try {
    const { token, deviceName } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Token required' });
    await pool.query(`
      INSERT INTO device_tokens (user_id, token, device_name, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id, token) DO UPDATE SET
        device_name = COALESCE($3, device_tokens.device_name),
        updated_at = NOW()
    `, [req.user.publicId, token, deviceName || 'iPhone']);
    res.json({ success: true, message: 'Device registered' });
  } catch (error) {
    console.error('❌ Register device error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Unregister device token (on logout)
app.delete('/api/notifications/register', authenticateUser, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Token required' });
    await pool.query('DELETE FROM device_tokens WHERE user_id = $1 AND token = $2', [req.user.publicId, token]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get notification preferences
app.get('/api/notifications/preferences', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM notification_preferences WHERE user_id = $1', [req.user.publicId]);
    res.json({
      success: true,
      preferences: result.rows[0] || {
        trade_opened: true, trade_closed: true, weekly_summary: true,
        followers: true, copy_trade_signals: true
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update notification preferences
app.put('/api/notifications/preferences', authenticateUser, async (req, res) => {
  try {
    const { trade_opened, trade_closed, weekly_summary, followers, copy_trade_signals } = req.body;
    const result = await pool.query(`
      INSERT INTO notification_preferences
        (user_id, trade_opened, trade_closed, weekly_summary, followers, copy_trade_signals)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id) DO UPDATE SET
        trade_opened = COALESCE($2, notification_preferences.trade_opened),
        trade_closed = COALESCE($3, notification_preferences.trade_closed),
        weekly_summary = COALESCE($4, notification_preferences.weekly_summary),
        followers = COALESCE($5, notification_preferences.followers),
        copy_trade_signals = COALESCE($6, notification_preferences.copy_trade_signals),
        updated_at = NOW()
      RETURNING *
    `, [req.user.publicId, trade_opened, trade_closed, weekly_summary, followers, copy_trade_signals]);
    res.json({ success: true, preferences: result.rows[0] });
  } catch (error) {
    console.error('❌ Update preferences error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get notification history
app.get('/api/notifications/history', authenticateUser, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await pool.query(`
      SELECT id, type, title, body, data, status, sent_at
      FROM notification_log WHERE user_id = $1
      ORDER BY sent_at DESC LIMIT $2 OFFSET $3
    `, [req.user.publicId, Math.min(parseInt(limit), 100), parseInt(offset)]);
    res.json({ success: true, notifications: result.rows, count: result.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

console.log('✅ Phase 6: Notification routes installed');

// ============================================================================
// PHASE 8: ADMIN CONTROLS API ROUTES
// Add to server.js after Phase 6
// ============================================================================

// ============================================================================
// ADMIN MIDDLEWARE
// ============================================================================

const requireAdmin = async (req, res, next) => {
    try {
        const result = await pool.query(
            'SELECT role FROM admin_users WHERE user_id = $1',
            [req.user.publicId]
        );
        
        if (result.rows.length === 0) {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        
        req.admin = { role: result.rows[0].role };
        next();
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

const requireSuperAdmin = async (req, res, next) => {
    try {
        const result = await pool.query(
            'SELECT role FROM admin_users WHERE user_id = $1 AND role = $2',
            [req.user.publicId, 'super_admin']
        );
        
        if (result.rows.length === 0) {
            return res.status(403).json({ success: false, error: 'Super admin access required' });
        }
        
        next();
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// ============================================================================
// USER MODERATION
// ============================================================================

// Suspend user
app.post('/api/admin/users/:userId/suspend', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { reason, durationHours } = req.body;
        
        if (!reason) return res.status(400).json({ success: false, error: 'Reason required' });
        
        await pool.query(
            'SELECT suspend_user($1, $2, $3, $4)',
            [userId, req.user.publicId, reason, durationHours || null]
        );
        
        res.json({ success: true, message: 'User suspended' });
    } catch (error) {
        console.error('❌ Suspend error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Unsuspend user
app.post('/api/admin/users/:userId/unsuspend', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        
        await pool.query('UPDATE users SET is_suspended = false, suspended_until = NULL WHERE public_id = $1', [userId]);
        await pool.query(
            'INSERT INTO user_moderation (user_id, action, reason, admin_id) VALUES ($1, $2, $3, $4)',
            [userId, 'unsuspend', 'Admin action', req.user.publicId]
        );
        await pool.query('SELECT log_admin_action($1, $2, $3)', [req.user.publicId, 'UNSUSPEND_USER', userId]);
        
        res.json({ success: true, message: 'User unsuspended' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Ban user
app.post('/api/admin/users/:userId/ban', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { reason } = req.body;
        
        if (!reason) return res.status(400).json({ success: false, error: 'Reason required' });
        
        await pool.query('SELECT ban_user($1, $2, $3)', [userId, req.user.publicId, reason]);
        
        res.json({ success: true, message: 'User banned' });
    } catch (error) {
        console.error('❌ Ban error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Unban user
app.post('/api/admin/users/:userId/unban', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        
        await pool.query('UPDATE users SET is_banned = false, is_suspended = false WHERE public_id = $1', [userId]);
        await pool.query(
            'INSERT INTO user_moderation (user_id, action, reason, admin_id) VALUES ($1, $2, $3, $4)',
            [userId, 'unban', 'Admin action', req.user.publicId]
        );
        await pool.query('SELECT log_admin_action($1, $2, $3)', [req.user.publicId, 'UNBAN_USER', userId]);
        
        res.json({ success: true, message: 'User unbanned' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get moderation history for user
app.get('/api/admin/users/:userId/moderation', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(`
            SELECT um.*, a.username as admin_username
            FROM user_moderation um
            JOIN users a ON a.public_id = um.admin_id
            WHERE um.user_id = $1
            ORDER BY um.created_at DESC
        `, [userId]);
        
        res.json({ success: true, history: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================================
// VERIFIED BADGES
// ============================================================================

// Grant verified badge
app.post('/api/admin/users/:userId/verify', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { badgeType = 'verified', reason } = req.body;
        
        await pool.query(
            'SELECT grant_verified_badge($1, $2, $3, $4)',
            [userId, req.user.publicId, badgeType, reason]
        );
        
        res.json({ success: true, message: 'Verified badge granted' });
    } catch (error) {
        console.error('❌ Verify error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Revoke verified badge
app.delete('/api/admin/users/:userId/verify', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        
        await pool.query('UPDATE users SET is_verified = false WHERE public_id = $1', [userId]);
        await pool.query('DELETE FROM verified_badges WHERE user_id = $1', [userId]);
        await pool.query('SELECT log_admin_action($1, $2, $3)', [req.user.publicId, 'REVOKE_VERIFIED_BADGE', userId]);
        
        res.json({ success: true, message: 'Verified badge revoked' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================================
// CONTENT MODERATION
// ============================================================================

// Hide trade
app.post('/api/admin/trades/:tradeId/hide', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { tradeId } = req.params;
        const { reason } = req.body;
        
        if (!reason) return res.status(400).json({ success: false, error: 'Reason required' });
        
        await pool.query('UPDATE trades SET is_hidden = true WHERE id = $1', [tradeId]);
        await pool.query('UPDATE feed_events SET is_hidden = true WHERE trade_id = $1', [tradeId]);
        await pool.query(
            'INSERT INTO content_moderation (content_type, content_id, action, reason, admin_id) VALUES ($1, $2, $3, $4, $5)',
            ['trade', tradeId, 'hide', reason, req.user.publicId]
        );
        await pool.query(
            'SELECT log_admin_action($1, $2, NULL, $3, $4)',
            [req.user.publicId, 'HIDE_TRADE', 'trade', tradeId]
        );
        
        res.json({ success: true, message: 'Trade hidden' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Unhide trade
app.post('/api/admin/trades/:tradeId/unhide', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { tradeId } = req.params;
        
        await pool.query('UPDATE trades SET is_hidden = false WHERE id = $1', [tradeId]);
        await pool.query('UPDATE feed_events SET is_hidden = false WHERE trade_id = $1', [tradeId]);
        await pool.query(
            'INSERT INTO content_moderation (content_type, content_id, action, reason, admin_id) VALUES ($1, $2, $3, $4, $5)',
            ['trade', tradeId, 'unhide', 'Admin action', req.user.publicId]
        );
        
        res.json({ success: true, message: 'Trade unhidden' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================================
// FEATURE FLAGS
// ============================================================================

// Get all feature flags
app.get('/api/admin/features', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM feature_flags ORDER BY flag_name');
        res.json({ success: true, features: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update feature flag
app.put('/api/admin/features/:flagName', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { flagName } = req.params;
        const { enabled, rolloutPercentage, whitelistUserIds, blacklistUserIds } = req.body;
        
        const result = await pool.query(`
            UPDATE feature_flags SET
                enabled = COALESCE($2, enabled),
                rollout_percentage = COALESCE($3, rollout_percentage),
                whitelist_user_ids = COALESCE($4, whitelist_user_ids),
                blacklist_user_ids = COALESCE($5, blacklist_user_ids),
                updated_at = NOW()
            WHERE flag_name = $1
            RETURNING *
        `, [flagName, enabled, rolloutPercentage, whitelistUserIds, blacklistUserIds]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Feature flag not found' });
        }
        
        await pool.query('SELECT log_admin_action($1, $2)', [req.user.publicId, 'UPDATE_FEATURE_FLAG']);
        
        res.json({ success: true, feature: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Check if user can access feature
app.get('/api/features/:flagName', authenticateUser, async (req, res) => {
    try {
        const { flagName } = req.params;
        const result = await pool.query(
            'SELECT can_access_feature($1, $2) as can_access',
            [req.user.publicId, flagName]
        );
        
        res.json({ success: true, canAccess: result.rows[0].can_access });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================================
// ADMIN DASHBOARD
// ============================================================================

// Get admin dashboard stats
app.get('/api/admin/dashboard', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days') as new_users_week,
                (SELECT COUNT(*) FROM users WHERE is_suspended = true) as suspended_users,
                (SELECT COUNT(*) FROM users WHERE is_banned = true) as banned_users,
                (SELECT COUNT(*) FROM users WHERE is_verified = true) as verified_users,
                (SELECT COUNT(*) FROM trades) as total_trades,
                (SELECT COUNT(*) FROM trades WHERE is_hidden = true) as hidden_trades,
                (SELECT COUNT(*) FROM admin_activity_log WHERE created_at > NOW() - INTERVAL '24 hours') as admin_actions_24h
        `);
        
        const recentActions = await pool.query(`
            SELECT aal.*, u.username as admin_username
            FROM admin_activity_log aal
            JOIN users u ON u.public_id = aal.admin_id
            ORDER BY aal.created_at DESC
            LIMIT 20
        `);
        
        res.json({
            success: true,
            stats: stats.rows[0],
            recentActions: recentActions.rows
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get flagged content
app.get('/api/admin/flagged', authenticateUser, requireAdmin, async (req, res) => {
    try {
        // This would integrate with a user reporting system
        // For now, return recent moderation actions
        const result = await pool.query(`
            SELECT cm.*, u.username as admin_username
            FROM content_moderation cm
            JOIN users u ON u.public_id = cm.admin_id
            ORDER BY cm.created_at DESC
            LIMIT 50
        `);
        
        res.json({ success: true, flagged: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

console.log('✅ Phase 8: Admin control routes installed');

// ============================================================================
// END PHASE 8 ROUTES
// ============================================================================

// ============================================================================
// ADMIN PANEL WEB INTERFACE (PORT 4000)
// ============================================================================

const adminApp = express();
const ADMIN_PORT = process.env.ADMIN_PORT || 4000;

adminApp.use(cors());
adminApp.use(express.json());
adminApp.use(express.static(path.join(__dirname, 'admin-public')));

// Serve admin panel HTML
adminApp.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-public', 'index.html'));
});

// Start admin panel server
const adminServer = adminApp.listen(ADMIN_PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   🖥️  ADMIN PANEL ACTIVE               ║
║                                        ║
║   Port: ${ADMIN_PORT}                            ║
║   URL: http://localhost:${ADMIN_PORT}           ║
║   Open this URL in Chrome/Safari       ║
╚════════════════════════════════════════╝
  `);
});

// ============================================================================
// BROKERAGE & KYC API ROUTES
// ============================================================================

// Submit KYC data
app.post('/api/brokerage/kyc', authenticateUser, async (req, res) => {
  try {
    const {
      firstName, lastName, dateOfBirth, ssn, phoneNumber,
      streetAddress, unit, city, state, postalCode,
      employmentStatus, employerName, occupation,
      annualIncome, netWorth, investmentExperience, riskTolerance
    } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !dateOfBirth || !ssn || !streetAddress || !city || !state || !postalCode) {
      return res.status(400).json({ success: false, error: 'Missing required KYC fields' });
    }

    // Save KYC data
    await pool.query(`
      INSERT INTO kyc_data (
        user_id, first_name, last_name, date_of_birth, ssn_last_4, ssn_encrypted,
        phone_number, street_address, city, state, postal_code,
        employment_status, employer_name, occupation,
        annual_income_range, net_worth_range, investment_experience, risk_tolerance, ip_address
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (user_id) DO UPDATE SET
        first_name = $2, last_name = $3, date_of_birth = $4,
        ssn_last_4 = $5, ssn_encrypted = $6, phone_number = $7,
        street_address = $8, city = $9, state = $10, postal_code = $11,
        employment_status = $12, employer_name = $13, occupation = $14,
        annual_income_range = $15, net_worth_range = $16,
        investment_experience = $17, risk_tolerance = $18, updated_at = NOW()
    `, [
      req.user.publicId, firstName, lastName, dateOfBirth,
      ssn.slice(-4), ssn, phoneNumber, streetAddress, city, state, postalCode,
      employmentStatus, employerName || '', occupation || '',
      annualIncome, netWorth, investmentExperience, riskTolerance, req.ip
    ]);

    // Update user KYC status
    await pool.query(
      'UPDATE users SET kyc_status = $1, kyc_submitted_at = NOW() WHERE public_id = $2',
      ['SUBMITTED', req.user.publicId]
    );

    res.json({ success: true, message: 'KYC data submitted' });
  } catch (error) {
    console.error('KYC submission error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get KYC status
app.get('/api/brokerage/kyc/status', authenticateUser, async (req, res) => {
  try {
    const user = await pool.query(
      'SELECT kyc_status, alpaca_account_status, alpaca_account_id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    const hasKYCData = await pool.query(
      'SELECT COUNT(*) as count FROM kyc_data WHERE user_id = $1',
      [req.user.publicId]
    );

    res.json({
      success: true,
      kycStatus: user.rows[0].kyc_status || 'NOT_STARTED',
      accountStatus: user.rows[0].alpaca_account_status || 'NOT_CREATED',
      hasAccount: !!user.rows[0].alpaca_account_id,
      hasKYCData: parseInt(hasKYCData.rows[0].count) > 0
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create brokerage account
app.post('/api/brokerage/account/create', authenticateUser, async (req, res) => {
  try {
    // Check if account already exists
    const existing = await pool.query(
      'SELECT alpaca_account_id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    if (existing.rows[0].alpaca_account_id) {
      return res.status(400).json({ success: false, error: 'Account already exists' });
    }

    // Get KYC data
    const kycResult = await pool.query(
      'SELECT * FROM kyc_data WHERE user_id = $1',
      [req.user.publicId]
    );

    if (kycResult.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'KYC data not submitted' });
    }

    const kyc = kycResult.rows[0];
    const user = await pool.query('SELECT email FROM users WHERE public_id = $1', [req.user.publicId]);

    // Create Alpaca brokerage account
    const accountData = {
      email: user.rows[0].email,
      firstName: kyc.first_name,
      lastName: kyc.last_name,
      dateOfBirth: kyc.date_of_birth,
      taxId: kyc.ssn_encrypted,
      phoneNumber: kyc.phone_number,
      address: kyc.street_address,
      city: kyc.city,
      state: kyc.state,
      postalCode: kyc.postal_code,
      country: kyc.country || 'USA'
    };

    const alpacaAccount = await brokerService.createBrokerageAccount(accountData);

    // Save to database
    await brokerService.saveAccountToDatabase(req.user.publicId, alpacaAccount);

    res.json({
      success: true,
      message: 'Brokerage account created',
      accountStatus: alpacaAccount.status
    });
  } catch (error) {
    console.error('Account creation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get account status
app.get('/api/brokerage/account/status', authenticateUser, async (req, res) => {
  try {
    const user = await pool.query(
      'SELECT alpaca_account_id, alpaca_account_status FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    if (!user.rows[0].alpaca_account_id) {
      return res.json({ success: true, hasAccount: false });
    }

    const status = await brokerService.checkAccountStatus(user.rows[0].alpaca_account_id);

    res.json({
      success: true,
      hasAccount: true,
      ...status
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get account portfolio
app.get('/api/brokerage/account/portfolio', authenticateUser, async (req, res) => {
  try {
    const user = await pool.query(
      'SELECT alpaca_account_id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    if (!user.rows[0].alpaca_account_id) {
      return res.status(404).json({ success: false, error: 'No brokerage account' });
    }

    const portfolio = await brokerService.getAccountPortfolio(user.rows[0].alpaca_account_id);

    res.json({
      success: true,
      portfolio
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Link bank account via Plaid
app.post('/api/brokerage/bank/link', authenticateUser, async (req, res) => {
  try {
    const { publicToken, accountId, metadata } = req.body;

    // Exchange Plaid public token for access token
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken
    });

    const accessToken = exchangeResponse.data.access_token;

    // Get bank account details
    const authResponse = await plaidClient.authGet({
      access_token: accessToken
    });

    const account = authResponse.data.accounts.find(a => a.account_id === accountId);
    const numbers = authResponse.data.numbers.ach.find(n => n.account_id === accountId);

    // Get user's Alpaca account
    const user = await pool.query(
      'SELECT alpaca_account_id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    if (!user.rows[0].alpaca_account_id) {
      return res.status(400).json({ success: false, error: 'Brokerage account not created yet' });
    }

    // Create ACH relationship in Alpaca
    const achRelationship = await brokerService.createACHRelationship(user.rows[0].alpaca_account_id, {
      accountOwnerName: metadata.account.name,
      accountType: account.subtype === 'checking' ? 'CHECKING' : 'SAVINGS',
      accountNumber: numbers.account,
      routingNumber: numbers.routing,
      nickname: account.name
    });

    // Save to database
    await pool.query(`
      INSERT INTO bank_accounts (
        user_id, alpaca_ach_relationship_id, plaid_account_id,
        bank_name, account_type, account_mask, account_owner_name, status, is_primary
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      req.user.publicId,
      achRelationship.id,
      accountId,
      metadata.institution.name,
      account.subtype.toUpperCase(),
      account.mask,
      metadata.account.name,
      'ACTIVE',
      true
    ]);

    res.json({ success: true, message: 'Bank account linked' });
  } catch (error) {
    console.error('Bank link error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get linked bank accounts
app.get('/api/brokerage/bank/accounts', authenticateUser, async (req, res) => {
  try {
    const accounts = await pool.query(
      'SELECT id, bank_name, account_type, account_mask, is_primary, status FROM bank_accounts WHERE user_id = $1',
      [req.user.publicId]
    );

    res.json({ success: true, accounts: accounts.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Deposit money
app.post('/api/brokerage/deposit', authenticateUser, async (req, res) => {
  try {
    const { amount, bankAccountId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    // Get bank account
    const bankAccount = await pool.query(
      'SELECT alpaca_ach_relationship_id FROM bank_accounts WHERE id = $1 AND user_id = $2',
      [bankAccountId, req.user.publicId]
    );

    if (bankAccount.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Bank account not found' });
    }

    // Get Alpaca account
    const user = await pool.query(
      'SELECT alpaca_account_id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    // Create transfer
    const transfer = await brokerService.createTransfer(user.rows[0].alpaca_account_id, {
      amount,
      direction: 'INCOMING',
      achRelationshipId: bankAccount.rows[0].alpaca_ach_relationship_id
    });

    // Save to database
    await pool.query(`
      INSERT INTO transfers (user_id, alpaca_transfer_id, bank_account_id, amount, direction, status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.publicId, transfer.id, bankAccountId, amount, 'INCOMING', transfer.status]);

    res.json({ success: true, message: 'Deposit initiated', transfer });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Withdraw money
app.post('/api/brokerage/withdraw', authenticateUser, async (req, res) => {
  try {
    const { amount, bankAccountId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const bankAccount = await pool.query(
      'SELECT alpaca_ach_relationship_id FROM bank_accounts WHERE id = $1 AND user_id = $2',
      [bankAccountId, req.user.publicId]
    );

    if (bankAccount.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Bank account not found' });
    }

    const user = await pool.query(
      'SELECT alpaca_account_id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    const transfer = await brokerService.createTransfer(user.rows[0].alpaca_account_id, {
      amount,
      direction: 'OUTGOING',
      achRelationshipId: bankAccount.rows[0].alpaca_ach_relationship_id
    });

    await pool.query(`
      INSERT INTO transfers (user_id, alpaca_transfer_id, bank_account_id, amount, direction, status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.publicId, transfer.id, bankAccountId, amount, 'OUTGOING', transfer.status]);

    res.json({ success: true, message: 'Withdrawal initiated', transfer });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get transfer history
app.get('/api/brokerage/transfers', authenticateUser, async (req, res) => {
  try {
    const transfers = await pool.query(`
      SELECT t.*, b.bank_name, b.account_mask
      FROM transfers t
      LEFT JOIN bank_accounts b ON b.id = t.bank_account_id
      WHERE t.user_id = $1
      ORDER BY t.initiated_at DESC
      LIMIT 50
    `, [req.user.publicId]);

    res.json({ success: true, transfers: transfers.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Place trade (using user's brokerage account)
app.post('/api/brokerage/trade', authenticateUser, async (req, res) => {
  try {
    const { symbol, qty, side, type = 'market', limitPrice, stopPrice } = req.body;

    // Get user's Alpaca account
    const user = await pool.query(
      'SELECT alpaca_account_id, alpaca_account_status FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    if (!user.rows[0].alpaca_account_id) {
      return res.status(400).json({ success: false, error: 'No brokerage account' });
    }

    if (user.rows[0].alpaca_account_status !== 'ACTIVE') {
      return res.status(400).json({ success: false, error: 'Account not approved for trading' });
    }

    // Place order
    const order = await brokerService.placeOrder(user.rows[0].alpaca_account_id, {
      symbol,
      qty,
      side,
      type,
      limitPrice,
      stopPrice
    });

    // Save to database
    const userIdResult = await pool.query('SELECT id FROM users WHERE public_id = $1', [req.user.publicId]);
    
    await pool.query(`
      INSERT INTO trades (
        user_id, symbol, side, quantity, order_type, alpaca_order_id, alpaca_account_id, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      userIdResult.rows[0].id,
      symbol,
      side,
      qty,
      type,
      order.id,
      user.rows[0].alpaca_account_id,
      order.status
    ]);

    res.json({ success: true, order });
  } catch (error) {
    console.error('Trade error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get user's positions
app.get('/api/brokerage/positions', authenticateUser, async (req, res) => {
  try {
    const user = await pool.query(
      'SELECT alpaca_account_id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    if (!user.rows[0].alpaca_account_id) {
      return res.json({ success: true, positions: [] });
    }

    const positions = await brokerService.getPositions(user.rows[0].alpaca_account_id);

    res.json({ success: true, positions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get user's orders
app.get('/api/brokerage/orders', authenticateUser, async (req, res) => {
  try {
    const { status = 'all' } = req.query;
    
    const user = await pool.query(
      'SELECT alpaca_account_id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    if (!user.rows[0].alpaca_account_id) {
      return res.json({ success: true, orders: [] });
    }

    const orders = await brokerService.getOrders(user.rows[0].alpaca_account_id, status);

    res.json({ success: true, orders });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

console.log('✅ Brokerage API routes installed');

// ============================================================================
// TRADING ROOMS API ROUTES
// Add to server-ultimate.js before ERROR HANDLING
// ============================================================================

const { v4: uuidv4 } = require('uuid');

// Get all public rooms
app.get('/api/rooms', authenticateUser, async (req, res) => {
  try {
    const { search } = req.query;
    
    let query = `
      SELECT * FROM room_stats
      WHERE is_public = true
    `;
    
    const params = [];
    
    if (search) {
      query += ` AND (name ILIKE $1 OR description ILIKE $1)`;
      params.push(`%${search}%`);
    }
    
    query += ` ORDER BY is_live DESC, member_count DESC, created_at DESC LIMIT 50`;
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      rooms: result.rows
    });
  } catch (error) {
    console.error('Get rooms error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single room details
app.get('/api/rooms/:roomId', authenticateUser, async (req, res) => {
  try {
    const { roomId } = req.params;
    
    const room = await pool.query(
      'SELECT * FROM room_stats WHERE room_id = $1',
      [roomId]
    );
    
    if (room.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    // Check if user is member
    const userIdResult = await pool.query(
      'SELECT id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );
    
    const membership = await pool.query(
      'SELECT role FROM room_members WHERE room_id = (SELECT id FROM trading_rooms WHERE room_id = $1) AND user_id = $2',
      [roomId, userIdResult.rows[0].id]
    );
    
    res.json({
      success: true,
      room: room.rows[0],
      isMember: membership.rows.length > 0,
      userRole: membership.rows[0]?.role || null
    });
  } catch (error) {
    console.error('Get room error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create room
app.post('/api/rooms', authenticateUser, async (req, res) => {
  try {
    const { name, description, isPublic = true, maxMembers = 100 } = req.body;
    
    if (!name || name.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Room name must be at least 3 characters' });
    }
    
    const userIdResult = await pool.query(
      'SELECT id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );
    
    const roomId = uuidv4();
    
    const result = await pool.query(`
      INSERT INTO trading_rooms (room_id, name, description, creator_id, is_public, max_members, is_live)
      VALUES ($1, $2, $3, $4, $5, $6, true)
      RETURNING *
    `, [roomId, name.trim(), description?.trim() || null, userIdResult.rows[0].id, isPublic, maxMembers]);
    
    // Get full room stats
    const roomStats = await pool.query(
      'SELECT * FROM room_stats WHERE room_id = $1',
      [roomId]
    );
    
    res.json({
      success: true,
      room: roomStats.rows[0]
    });
  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Join room
app.post('/api/rooms/:roomId/join', authenticateUser, async (req, res) => {
  try {
    const { roomId } = req.params;
    
    const userIdResult = await pool.query(
      'SELECT id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );
    
    const room = await pool.query(
      'SELECT id, max_members FROM trading_rooms WHERE room_id = $1',
      [roomId]
    );
    
    if (room.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    // Check current member count
    const memberCount = await pool.query(
      'SELECT COUNT(*) as count FROM room_members WHERE room_id = $1',
      [room.rows[0].id]
    );
    
    if (parseInt(memberCount.rows[0].count) >= room.rows[0].max_members) {
      return res.status(400).json({ success: false, error: 'Room is full' });
    }
    
    // Add member
    await pool.query(`
      INSERT INTO room_members (room_id, user_id, role)
      VALUES ($1, $2, 'member')
      ON CONFLICT (room_id, user_id) DO NOTHING
    `, [room.rows[0].id, userIdResult.rows[0].id]);
    
    res.json({ success: true, message: 'Joined room successfully' });
  } catch (error) {
    console.error('Join room error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Leave room
app.post('/api/rooms/:roomId/leave', authenticateUser, async (req, res) => {
  try {
    const { roomId } = req.params;
    
    const userIdResult = await pool.query(
      'SELECT id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );
    
    await pool.query(`
      DELETE FROM room_members
      WHERE room_id = (SELECT id FROM trading_rooms WHERE room_id = $1)
      AND user_id = $2
      AND role != 'creator'
    `, [roomId, userIdResult.rows[0].id]);
    
    res.json({ success: true, message: 'Left room successfully' });
  } catch (error) {
    console.error('Leave room error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get room messages
app.get('/api/rooms/:roomId/messages', authenticateUser, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 50, before } = req.query;
    
    const userIdResult = await pool.query(
      'SELECT id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );
    
    // Check if user is member
    const membership = await pool.query(`
      SELECT 1 FROM room_members
      WHERE room_id = (SELECT id FROM trading_rooms WHERE room_id = $1)
      AND user_id = $2
    `, [roomId, userIdResult.rows[0].id]);
    
    if (membership.rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Not a member of this room' });
    }
    
    let query = `
      SELECT 
        rm.id,
        rm.message_type,
        rm.content,
        rm.symbol,
        rm.trade_action,
        rm.price,
        rm.created_at,
        u.username,
        u.public_id as user_public_id,
        u.display_name,
        u.is_verified
      FROM room_messages rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = (SELECT id FROM trading_rooms WHERE room_id = $1)
    `;
    
    const params = [roomId];
    
    if (before) {
      query += ` AND rm.id < $2`;
      params.push(before);
    }
    
    query += ` ORDER BY rm.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const messages = await pool.query(query, params);
    
    res.json({
      success: true,
      messages: messages.rows.reverse()
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send message
app.post('/api/rooms/:roomId/messages', authenticateUser, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { content, messageType = 'text', symbol, tradeAction, price } = req.body;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Message cannot be empty' });
    }
    
    const userIdResult = await pool.query(
      'SELECT id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );
    
    // Check if user is member
    const membership = await pool.query(`
      SELECT 1 FROM room_members
      WHERE room_id = (SELECT id FROM trading_rooms WHERE room_id = $1)
      AND user_id = $2
    `, [roomId, userIdResult.rows[0].id]);
    
    if (membership.rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Not a member of this room' });
    }
    
    const message = await pool.query(`
      INSERT INTO room_messages (room_id, user_id, message_type, content, symbol, trade_action, price)
      VALUES (
        (SELECT id FROM trading_rooms WHERE room_id = $1),
        $2, $3, $4, $5, $6, $7
      )
      RETURNING *
    `, [roomId, userIdResult.rows[0].id, messageType, content.trim(), symbol, tradeAction, price]);
    
    // Update last_active_at for user
    await pool.query(`
      UPDATE room_members
      SET last_active_at = NOW()
      WHERE room_id = (SELECT id FROM trading_rooms WHERE room_id = $1)
      AND user_id = $2
    `, [roomId, userIdResult.rows[0].id]);
    
    res.json({
      success: true,
      message: message.rows[0]
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get user's rooms
app.get('/api/rooms/my/rooms', authenticateUser, async (req, res) => {
  try {
    const userIdResult = await pool.query(
      'SELECT id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );
    
    const rooms = await pool.query(`
      SELECT 
        rs.*,
        rm.role as user_role,
        rm.joined_at
      FROM room_stats rs
      JOIN room_members rm ON rm.room_id = rs.id
      WHERE rm.user_id = $1
      ORDER BY rm.last_active_at DESC
    `, [userIdResult.rows[0].id]);
    
    res.json({
      success: true,
      rooms: rooms.rows
    });
  } catch (error) {
    console.error('Get my rooms error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

console.log('✅ Trading Rooms API routes installed');

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   🏔️  EVEREST TRADING PLATFORM v3.0    ║
║                                        ║
║   Environment: ${ENV.toUpperCase().padEnd(27)}║
║   Server: http://0.0.0.0:${PORT}            ║
║   Local: http://localhost:${PORT}           ║
║   Network: http://10.200.139.195:${PORT}    ║
║   Database: ${pool ? '✅ Connected' : '❌ Disconnected'}           ║
║   Firebase Auth: ${firebaseInitialized ? '✅ Active' : '⚠️  Disabled'}      ║
║   Alpaca Trading: ${alpacaClient ? '✅ Active' : '⚠️  Disabled'}     ║
║   Plaid Banking: ${plaidClient ? '✅ Active' : '⚠️  Disabled'}      ║
║                                        ║
║   💰 Cash Management: ACTIVE            ║
║   🔒 Role-Based Auth: ENABLED           ║
║   📸 Image Upload: ENABLED              ║
║   👥 Social Features: ENABLED           ║
║   🔔 Notifications: ENABLED             ║
╚════════════════════════════════════════╝
  `);
  
  // Setup automated cron jobs
  cashManagement.setupCronJobs(pool);

  // Setup notification cron jobs
  notificationService.setupCronJobs(cron);
  
  console.log('🚀 Server ready to accept requests\n');
  console.log('✅ Phase 1: Profile routes installed');
  console.log('✅ Phase 1: Image upload routes installed');
  console.log('✅ Phase 2: Social features installed');
  console.log('   - User search');
  console.log('   - Follow/Unfollow system');
  console.log('   - Follower counts');
  console.log('✅ Phase 6: Notifications active');
  console.log('✅ Phase 8: Admin control routes active');
  console.log('✅ Brokerage API active (Real Trading)');
  console.log('\n💡 iOS App → http://localhost:3000');
  console.log('💡 Admin Panel → http://localhost:4000\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing servers...');
  server.close(() => {
    adminServer.close(() => {
      pool.end(() => {
        console.log('All servers and database closed');
        process.exit(0);
      });
    });
  });
});