const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// Telegram config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const DISABLE_TELEGRAM_MESSAGES = process.env.DISABLE_TELEGRAM_MESSAGES;;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Wallets to track
let TRACKING_WALLETS = [
  '5szGx4sTngM9528j1pN3ap8fbnWwdByHrvopBqLFu9PW',
  'BXvikrCePUMXyrvTvyyp3jddzL3KNvcJELQcET5eBFkh',
  'BDhpEzHgS2TQ7Y8Dmz6dwhAd6i5FZqHycV6TiqaxViC4',
  '6b8ydf4wnrYe66VmwhEmvGhfWvzLv8Ce5b57MGoVWWKe',
  '4yQ9ke3GE6oJndJH8DogjeaU6kabK1vRVGzqy2e8Kh2m',
  '3JPYL9xEPFjefV3tccrUwhLzME1mMq2dQSDeDebgzQi6',
];

// Programs id to track
const PROGRAMS = {
  JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  RAYDIUM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  PUMP_FUN_TOKEN_MINT_AUTH: 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
};

// Format string for Telegram Message
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

// Send message on bot Telegram
const sendTelegramMessage = async (message) => {
  if (DISABLE_TELEGRAM_MESSAGES) return;
  await bot.sendMessage(ADMIN_CHAT_ID, message);
};

// Print tracked wallet on bot Telegram
const printTrackedWalletTg = async (wallets) => {
  if (DISABLE_TELEGRAM_MESSAGES) return;
  let msgStr = 'Tracked wallets\n';
  wallets.forEach((item, index) => {
    msgStr += `${index + 1}: ${item}\n`;
  });
  await bot.sendMessage(ADMIN_CHAT_ID, msgStr);
};

class TokenUtils {
  constructor(connection) {
    this.connection = connection;
  }

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

class TransactionParser {
  constructor(connection) {
    this.connection = connection;
    this.tokenUtils = new TokenUtils(connection);
  }

  async parseTransaction(txDetails, dexInfo) {
    try {
      if (!txDetails || !txDetails[0]) return null;

      const nativeBalance =
        this.tokenUtils.calculateNativeBalanceChanges(txDetails);
      if (!nativeBalance) return null;

      const accountKeys = txDetails[0].transaction.message.accountKeys;
      const signerAccount = accountKeys.find((account) => account.signer);
      const owner = signerAccount?.pubkey.toString();

      // Analyze transfered token
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

      // Find token in and out
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

class SolanaMonitor {
  constructor(rpcUrl) {
    this.connection = new Connection(rpcUrl);
    this.parser = new TransactionParser(this.connection);
  }

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

// Function for manage the order of Telegram bot messages
const messageManager = async () => {
  console.log('DISABLE_TELEGRAM_MESSAGES:', DISABLE_TELEGRAM_MESSAGES);
  // Telegram start message
  await sendTelegramMessage('Wallet Tracker started.');
  await sendTelegramMessage('Monitoring.');
  // Telegram print wallets
  await printTrackedWalletTg(TRACKING_WALLETS);
};

// Start
const monitor = new SolanaMonitor('https://api.mainnet-beta.solana.com');
monitor.monitorWallets(TRACKING_WALLETS);
messageManager();
