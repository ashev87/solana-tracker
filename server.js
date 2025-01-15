const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

/**
 * Telegram Bot Configuration
 * Setup and initialization of Telegram bot for transaction notifications
 * Requires environment variables for secure token and chat ID storage
 */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const DISABLE_TELEGRAM_MESSAGES = process.env.DISABLE_TELEGRAM_MESSAGES;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

/**
 * Wallet Configuration
 * List of Solana wallet addresses to monitor for transactions
 * Each wallet will be tracked for specific DEX interactions
 */
let TRACKING_WALLETS = [
  '5szGx4sTngM9528j1pN3ap8fbnWwdByHrvopBqLFu9PW',
  'BXvikrCePUMXyrvTvyyp3jddzL3KNvcJELQcET5eBFkh',
  'BDhpEzHgS2TQ7Y8Dmz6dwhAd6i5FZqHycV6TiqaxViC4',
  '6b8ydf4wnrYe66VmwhEmvGhfWvzLv8Ce5b57MGoVWWKe',
  '4yQ9ke3GE6oJndJH8DogjeaU6kabK1vRVGzqy2e8Kh2m',
  '3JPYL9xEPFjefV3tccrUwhLzME1mMq2dQSDeDebgzQi6',
];

/**
 * DEX Program IDs Configuration
 * Mapping of different DEX programs on Solana to track specific interactions
 * Includes Jupiter, Raydium, and Pump.fun platforms
 */
const PROGRAMS = {
  JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  RAYDIUM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  PUMP_FUN_TOKEN_MINT_AUTH: 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
};

/**
 * Formats JSON data into a readable string format for Telegram messages
 * Recursively processes nested objects and creates a formatted string
 * 
 * @param {Object} jsonData - The JSON data to format
 * @returns {string} Formatted string representation of the JSON data
 */
const formatJsonToString = (jsonData) => {
  const result = [];

  function processObject(obj, prefix = '') {
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;

      if (typeof value === 'object') {
        result.push(`${prefix}${key}:`);
        processObject(value, '  ');
      } else {
        result.push(`${prefix}${key}: ${value}`);
      }
    }
  }

  processObject(jsonData);
  return result.join('\n');
};

/**
 * Sends a message to the configured Telegram chat
 * Respects the DISABLE_TELEGRAM_MESSAGES flag for testing environments
 * 
 * @param {string} message - Message to send to Telegram
 */
const sendTelegramMessage = async (message) => {
  if (DISABLE_TELEGRAM_MESSAGES) return;
  await bot.sendMessage(ADMIN_CHAT_ID, message);
};

/**
 * Prints the list of tracked wallets to Telegram
 * Formats the wallet addresses in a numbered list
 * 
 * @param {string[]} wallets - Array of wallet addresses being tracked
 */
const printTrackedWalletTg = async (wallets) => {
  if (DISABLE_TELEGRAM_MESSAGES) return;
  let msgStr = 'Tracked wallets\n';
  wallets.forEach((item, index) => {
    msgStr += `${index + 1}: ${item}\n`;
  });
  await bot.sendMessage(ADMIN_CHAT_ID, msgStr);
};

/**
 * TokenUtils Class
 * Utility class for token-related operations on Solana
 * Handles token mint address retrieval and balance calculations
 */
class TokenUtils {
  /**
   * @param {Connection} connection - Solana RPC connection instance
   */
  constructor(connection) {
    this.connection = connection;
  }

  /**
   * Retrieves the mint address for a given token account
   * 
   * @param {string} accountAddress - Token account address
   * @returns {Promise<string|null>} Token mint address or null if not found
   */
  async getTokenMintAddress(accountAddress) {
    try {
      const accountInfo = await this.connection.getParsedAccountInfo(
        new PublicKey(accountAddress),
      );
      return accountInfo.value?.data?.parsed?.info?.mint || null;
    } catch (error) {
      console.log(error);
      return null;
    }
  }

  /**
   * Calculates SOL balance changes for a transaction
   * Determines if the transaction was a buy or sell based on balance change
   * 
   * @param {Object[]} transactionDetails - Transaction information from Solana
   * @returns {Object|null} Transaction type and balance change amount
   */
  calculateNativeBalanceChanges(transactionDetails) {
    try {
      const preBalance = transactionDetails[0].meta.preBalances[0];
      const postBalance = transactionDetails[0].meta.postBalances[0];
      const balanceChange = (postBalance - preBalance) / 1e9;

      return {
        type: balanceChange < 0 ? 'buy' : 'sell',
        balanceChange: Math.abs(balanceChange),
      };
    } catch (error) {
      console.log(error);
      return null;
    }
  }
}

/**
 * TransactionParser Class
 * Handles parsing of Solana transactions to extract relevant swap information
 * Analyzes token transfers and balance changes
 */
class TransactionParser {
  /**
   * @param {Connection} connection - Solana RPC connection instance
   */
  constructor(connection) {
    this.connection = connection;
    this.tokenUtils = new TokenUtils(connection);
  }

  /**
   * Parses transaction details to extract swap information
   * 
   * @param {Object[]} txDetails - Transaction details from Solana
   * @param {Object} dexInfo - Information about the DEX used
   * @returns {Promise<Object|null>} Parsed transaction information or null if invalid
   */
  async parseTransaction(txDetails, dexInfo) {
    try {
      if (!txDetails || !txDetails[0]) return null;

      const nativeBalance =
        this.tokenUtils.calculateNativeBalanceChanges(txDetails);
      if (!nativeBalance) return null;

      const accountKeys = txDetails[0].transaction.message.accountKeys;
      const signerAccount = accountKeys.find((account) => account.signer);
      const owner = signerAccount?.pubkey.toString();

      // Extract token transfers from instructions
      const transfers = [];
      txDetails[0].meta?.innerInstructions?.forEach((instruction) => {
        instruction.instructions.forEach((ix) => {
          if (ix.parsed?.type === 'transfer' && ix.parsed.info.amount) {
            transfers.push({
              amount: ix.parsed.info.amount,
              source: ix.parsed.info.source,
              destination: ix.parsed.info.destination,
            });
          }
        });
      });

      if (transfers.length === 0) return null;

      // Analyze first and last transfers to determine swap details
      const firstTransfer = transfers[0];
      const lastTransfer = transfers[transfers.length - 1];

      const [tokenInMint, tokenOutMint] = await Promise.all([
        this.tokenUtils.getTokenMintAddress(lastTransfer.source),
        this.tokenUtils.getTokenMintAddress(firstTransfer.destination),
      ]);

      return {
        type: nativeBalance.type,
        monitored_wallet: owner,
        dex: dexInfo.dex,
        operation: dexInfo.type,
        tokenIn: {
          mint: tokenInMint,
          amount: (lastTransfer.amount / 1e9).toFixed(6),
        },
        tokenOut: {
          mint: tokenOutMint,
          amount: (firstTransfer.amount / 1e9).toFixed(6),
        },
        signature: txDetails[0].transaction.signatures[0],
      };
    } catch (error) {
      console.error('Error parsing transaction:', error);
      return null;
    }
  }
}

/**
 * SolanaMonitor Class
 * Main class for monitoring Solana wallet activities
 * Tracks transactions and DEX interactions for specified wallets
 */
class SolanaMonitor {
  /**
   * @param {string} rpcUrl - Solana RPC endpoint URL
   */
  constructor(rpcUrl) {
    this.connection = new Connection(rpcUrl);
    this.parser = new TransactionParser(this.connection);
  }

  /**
   * Starts monitoring specified wallets for transactions
   * Sets up log listeners for each wallet
   * 
   * @param {string[]} wallets - Array of wallet addresses to monitor
   */
  async monitorWallets(wallets) {
    wallets.forEach((wallet) => {
      this.connection.onLogs(
        new PublicKey(wallet),
        async (logs) => {
          try {
            const dexInfo = this.identifyDex(logs.logs);
            if (!dexInfo.dex) return;

            const txDetails = await this.connection.getParsedTransactions(
              [logs.signature],
              { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
            );

            const parsedTx = await this.parser.parseTransaction(
              txDetails,
              dexInfo,
            );
            if (parsedTx) {
              console.log('New Transaction:', parsedTx);
              sendTelegramMessage(formatJsonToString(parsedTx));
            }
          } catch (error) {
            console.error('Error processing transaction:', error);
          }
        },
        'confirmed',
      );
      console.log(`Monitoring wallet: ${wallet}`);
    });
  }

  /**
   * Identifies the DEX used in a transaction based on program IDs
   * 
   * @param {string[]} logs - Transaction logs
   * @returns {Object} DEX information including name and operation type
   */
  identifyDex(logs) {
    if (!logs?.length) return { dex: null, type: null };

    const logString = logs.join(' ');

    if (logString.includes(PROGRAMS.PUMP_FUN_TOKEN_MINT_AUTH)) {
      return { dex: 'Pump.fun', type: 'mint' };
    }
    if (logString.includes(PROGRAMS.PUMP_FUN)) {
      return { dex: 'Pump.fun', type: 'swap' };
    }
    if (logString.includes(PROGRAMS.JUPITER)) {
      return { dex: 'Jupiter', type: 'swap' };
    }
    if (logString.includes(PROGRAMS.RAYDIUM)) {
      return { dex: 'Raydium', type: 'swap' };
    }

    return { dex: null, type: null };
  }
}

/**
 * Message Manager
 * Handles the initialization sequence of Telegram bot messages
 * Sends startup notifications and prints tracked wallet information
 */
const messageManager = async () => {
  console.log('DISABLE_TELEGRAM_MESSAGES:', DISABLE_TELEGRAM_MESSAGES);
  await sendTelegramMessage('Wallet Tracker started.');
  await sendTelegramMessage('Monitoring.');
  await printTrackedWalletTg(TRACKING_WALLETS);
};

// Initialize and start the monitoring system
const monitor = new SolanaMonitor('https://api.mainnet-beta.solana.com');
monitor.monitorWallets(TRACKING_WALLETS);
messageManager();

const express = require('express');
const app = express();

// Specify the port Render assigns
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
