// ============================================================================
// ALPACA BROKER API SERVICE
// Multi-user brokerage account management for real trading
// ============================================================================

const axios = require('axios');

class AlpacaBrokerService {
  constructor(pool) {
    this.pool = pool;
    this.apiKey = process.env.ALPACA_BROKER_API_KEY;
    this.apiSecret = process.env.ALPACA_BROKER_API_SECRET;
    this.baseURL = 'https://broker-api.alpaca.markets/v1';
    
    if (!this.apiKey || !this.apiSecret) {
      console.warn('⚠️  Alpaca Broker API credentials not configured');
    } else {
      console.log('✅ Alpaca Broker API initialized (Real Trading)');
    }
  }

  // ============================================================================
  // HTTP CLIENT
  // ============================================================================

  async request(method, endpoint, data = null) {
    try {
      const response = await axios({
        method,
        url: `${this.baseURL}${endpoint}`,
        headers: {
          'APCA-API-KEY-ID': this.apiKey,
          'APCA-API-SECRET-KEY': this.apiSecret,
          'Content-Type': 'application/json'
        },
        data
      });
      return response.data;
    } catch (error) {
      console.error(`Alpaca API Error (${endpoint}):`, error.response?.data || error.message);
      throw error;
    }
  }

  // ============================================================================
  // ACCOUNT CREATION
  // ============================================================================

  async createBrokerageAccount(userData) {
    const {
      email,
      firstName,
      lastName,
      dateOfBirth,
      taxId,
      phoneNumber,
      address,
      city,
      state,
      postalCode,
      country = 'USA',
      fundingSource = 'plaid'
    } = userData;

    // Create Alpaca account
    const accountData = {
      contact: {
        email_address: email,
        phone_number: phoneNumber,
        street_address: [address],
        city,
        state,
        postal_code: postalCode,
        country
      },
      identity: {
        given_name: firstName,
        family_name: lastName,
        date_of_birth: dateOfBirth, // Format: YYYY-MM-DD
        tax_id: taxId,
        tax_id_type: 'USA_SSN',
        country_of_citizenship: country,
        country_of_birth: country,
        country_of_tax_residence: country,
        funding_source: [fundingSource]
      },
      disclosures: {
        is_control_person: false,
        is_affiliated_exchange_or_finra: false,
        is_politically_exposed: false,
        immediate_family_exposed: false
      },
      agreements: [
        {
          agreement: 'margin_agreement',
          signed_at: new Date().toISOString(),
          ip_address: '0.0.0.0' // Should be user's real IP
        },
        {
          agreement: 'account_agreement',
          signed_at: new Date().toISOString(),
          ip_address: '0.0.0.0'
        },
        {
          agreement: 'customer_agreement',
          signed_at: new Date().toISOString(),
          ip_address: '0.0.0.0'
        }
      ]
    };

    const alpacaAccount = await this.request('POST', '/accounts', accountData);
    
    return {
      alpacaAccountId: alpacaAccount.id,
      accountNumber: alpacaAccount.account_number,
      status: alpacaAccount.status,
      createdAt: alpacaAccount.created_at
    };
  }

  // ============================================================================
  // ACCOUNT MANAGEMENT
  // ============================================================================

  async getAccount(alpacaAccountId) {
    return await this.request('GET', `/accounts/${alpacaAccountId}`);
  }

  async getAccountActivities(alpacaAccountId, activityTypes = null) {
    let endpoint = `/accounts/${alpacaAccountId}/activities`;
    if (activityTypes) {
      endpoint += `?activity_types=${activityTypes.join(',')}`;
    }
    return await this.request('GET', endpoint);
  }

  async getAccountPortfolio(alpacaAccountId) {
    return await this.request('GET', `/accounts/${alpacaAccountId}/account`);
  }

  // ============================================================================
  // KYC & VERIFICATION
  // ============================================================================

  async uploadDocument(alpacaAccountId, documentType, documentSubType, content, mimeType) {
    const formData = {
      document_type: documentType, // 'identity_verification', 'address_verification'
      document_sub_type: documentSubType, // 'passport', 'drivers_license', 'utility_bill'
      content, // Base64 encoded
      mime_type: mimeType // 'image/jpeg', 'image/png', 'application/pdf'
    };

    return await this.request('POST', `/accounts/${alpacaAccountId}/documents`, formData);
  }

  async getDocuments(alpacaAccountId) {
    return await this.request('GET', `/accounts/${alpacaAccountId}/documents`);
  }

  // ============================================================================
  // FUNDING (ACH TRANSFERS)
  // ============================================================================

  async createACHRelationship(alpacaAccountId, bankData) {
    const achData = {
      account_owner_name: bankData.accountOwnerName,
      bank_account_type: bankData.accountType, // 'CHECKING' or 'SAVINGS'
      bank_account_number: bankData.accountNumber,
      bank_routing_number: bankData.routingNumber,
      nickname: bankData.nickname || 'Primary Bank'
    };

    return await this.request('POST', `/accounts/${alpacaAccountId}/ach_relationships`, achData);
  }

  async getACHRelationships(alpacaAccountId) {
    return await this.request('GET', `/accounts/${alpacaAccountId}/ach_relationships`);
  }

  async createTransfer(alpacaAccountId, transferData) {
    const { amount, direction, achRelationshipId } = transferData;
    
    const transfer = {
      transfer_type: 'ach',
      relationship_id: achRelationshipId,
      amount: amount.toString(),
      direction // 'INCOMING' (deposit) or 'OUTGOING' (withdrawal)
    };

    return await this.request('POST', `/accounts/${alpacaAccountId}/transfers`, transfer);
  }

  async getTransfers(alpacaAccountId) {
    return await this.request('GET', `/accounts/${alpacaAccountId}/transfers`);
  }

  // ============================================================================
  // TRADING
  // ============================================================================

  async placeOrder(alpacaAccountId, orderData) {
    const {
      symbol,
      qty,
      side, // 'buy' or 'sell'
      type = 'market', // 'market', 'limit', 'stop', 'stop_limit'
      timeInForce = 'day', // 'day', 'gtc', 'opg', 'cls', 'ioc', 'fok'
      limitPrice = null,
      stopPrice = null,
      clientOrderId = null
    } = orderData;

    const order = {
      symbol,
      qty: qty.toString(),
      side,
      type,
      time_in_force: timeInForce
    };

    if (limitPrice) order.limit_price = limitPrice.toString();
    if (stopPrice) order.stop_price = stopPrice.toString();
    if (clientOrderId) order.client_order_id = clientOrderId;

    return await this.request('POST', `/accounts/${alpacaAccountId}/orders`, order);
  }

  async getOrders(alpacaAccountId, status = 'all') {
    return await this.request('GET', `/accounts/${alpacaAccountId}/orders?status=${status}`);
  }

  async getOrder(alpacaAccountId, orderId) {
    return await this.request('GET', `/accounts/${alpacaAccountId}/orders/${orderId}`);
  }

  async cancelOrder(alpacaAccountId, orderId) {
    return await this.request('DELETE', `/accounts/${alpacaAccountId}/orders/${orderId}`);
  }

  async getPositions(alpacaAccountId) {
    return await this.request('GET', `/accounts/${alpacaAccountId}/positions`);
  }

  async getPosition(alpacaAccountId, symbol) {
    return await this.request('GET', `/accounts/${alpacaAccountId}/positions/${symbol}`);
  }

  async closePosition(alpacaAccountId, symbol) {
    return await this.request('DELETE', `/accounts/${alpacaAccountId}/positions/${symbol}`);
  }

  // ============================================================================
  // DATABASE HELPERS
  // ============================================================================

  async saveAccountToDatabase(userId, alpacaData) {
    await this.pool.query(`
      UPDATE users SET
        alpaca_account_id = $1,
        alpaca_account_number = $2,
        alpaca_account_status = $3,
        brokerage_account_created_at = $4
      WHERE public_id = $5
    `, [
      alpacaData.alpacaAccountId,
      alpacaData.accountNumber,
      alpacaData.status,
      alpacaData.createdAt,
      userId
    ]);
  }

  async getAccountFromDatabase(userId) {
    const result = await this.pool.query(
      'SELECT alpaca_account_id, alpaca_account_status FROM users WHERE public_id = $1',
      [userId]
    );
    return result.rows[0];
  }

  // ============================================================================
  // ACCOUNT STATUS CHECKS
  // ============================================================================

  async checkAccountStatus(alpacaAccountId) {
    const account = await this.getAccount(alpacaAccountId);
    
    return {
      status: account.status, // 'SUBMITTED', 'APPROVAL_PENDING', 'ACTIVE', 'ACCOUNT_CLOSED'
      tradingEnabled: account.status === 'ACTIVE',
      buyingPower: parseFloat(account.buying_power || 0),
      cash: parseFloat(account.cash || 0),
      portfolioValue: parseFloat(account.portfolio_value || 0)
    };
  }

  async isAccountApproved(alpacaAccountId) {
    const status = await this.checkAccountStatus(alpacaAccountId);
    return status.status === 'ACTIVE';
  }
}

module.exports = AlpacaBrokerService;
