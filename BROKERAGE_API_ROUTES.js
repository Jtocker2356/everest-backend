// ============================================================================
// BROKERAGE ACCOUNT & KYC API ROUTES
// Add to server-ultimate.js
// ============================================================================

const AlpacaBrokerService = require('./AlpacaBrokerService');
const brokerService = new AlpacaBrokerService(pool);

// ============================================================================
// KYC ONBOARDING
// ============================================================================

// Submit KYC data
app.post('/api/brokerage/kyc', authenticateUser, async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      dateOfBirth,
      ssn,
      phoneNumber,
      streetAddress,
      city,
      state,
      postalCode,
      employmentStatus,
      annualIncome,
      netWorth,
      investmentExperience,
      riskTolerance
    } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !dateOfBirth || !ssn || !streetAddress || !city || !state || !postalCode) {
      return res.status(400).json({ success: false, error: 'Missing required KYC fields' });
    }

    // Save KYC data (encrypt SSN in production!)
    await pool.query(`
      INSERT INTO kyc_data (
        user_id, first_name, last_name, date_of_birth, ssn_last_4, ssn_encrypted,
        phone_number, street_address, city, state, postal_code,
        employment_status, annual_income_range, net_worth_range,
        investment_experience, risk_tolerance, ip_address
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (user_id) DO UPDATE SET
        first_name = $2, last_name = $3, date_of_birth = $4,
        ssn_last_4 = $5, ssn_encrypted = $6, phone_number = $7,
        street_address = $8, city = $9, state = $10, postal_code = $11,
        employment_status = $12, annual_income_range = $13, net_worth_range = $14,
        investment_experience = $15, risk_tolerance = $16, updated_at = NOW()
    `, [
      req.user.publicId, firstName, lastName, dateOfBirth,
      ssn.slice(-4), ssn, // In production, encrypt the full SSN!
      phoneNumber, streetAddress, city, state, postalCode,
      employmentStatus, annualIncome, netWorth,
      investmentExperience, riskTolerance, req.ip
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
      'SELECT kyc_status, alpaca_account_status FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    res.json({
      success: true,
      kycStatus: user.rows[0].kyc_status,
      accountStatus: user.rows[0].alpaca_account_status
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Upload KYC document
app.post('/api/brokerage/kyc/document', authenticateUser, upload.single('document'), async (req, res) => {
  try {
    const { documentType, documentSubType } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    // Get user's Alpaca account ID
    const userResult = await pool.query(
      'SELECT alpaca_account_id FROM users WHERE public_id = $1',
      [req.user.publicId]
    );

    if (!userResult.rows[0].alpaca_account_id) {
      return res.status(400).json({ success: false, error: 'Brokerage account not created yet' });
    }

    const alpacaAccountId = userResult.rows[0].alpaca_account_id;

    // Convert to base64
    const fileBuffer = await fs.readFile(file.path);
    const base64Content = fileBuffer.toString('base64');

    // Upload to Alpaca
    const alpacaDoc = await brokerService.uploadDocument(
      alpacaAccountId,
      documentType,
      documentSubType,
      base64Content,
      file.mimetype
    );

    // Save to database
    await pool.query(`
      INSERT INTO kyc_documents (user_id, alpaca_document_id, document_type, document_sub_type, file_path, status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.publicId, alpacaDoc.id, documentType, documentSubType, file.path, 'PENDING']);

    // Clean up uploaded file
    await fs.unlink(file.path);

    res.json({ success: true, message: 'Document uploaded' });
  } catch (error) {
    console.error('Document upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// BROKERAGE ACCOUNT CREATION
// ============================================================================

// Create brokerage account (after KYC submitted)
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
      taxId: kyc.ssn_encrypted, // Decrypted in production
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

// ============================================================================
// FUNDING (DEPOSITS & WITHDRAWALS)
// ============================================================================

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

console.log('✅ Brokerage API routes installed');
