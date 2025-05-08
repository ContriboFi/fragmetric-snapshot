import web3 from '@solana/web3.js-1';
import web3v2 from '@solana/web3.js-2';
import { logger } from './logger';
import retry from 'promise-retry';

interface ConnectionPool {
  v1: web3.Connection;
  v2: web3v2.Rpc<any>;
  lastUsed: number;
  inUse: boolean;
}

interface ConnectionRequest {
  resolve: (connection: ConnectionPool) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

export class RPCClient {
  private pool: ConnectionPool[] = [];
  private readonly maxPoolSize: number = 5;
  private readonly poolTimeout: number = 300000; // 5 minutes
  private readonly maxQueueSize: number = 100;
  private readonly requestTimeout: number = 30000; // 30 seconds
  private memoryUsageInterval: NodeJS.Timeout | null = null;
  private connectionQueue: ConnectionRequest[] = [];
  public readonly cluster: 'mainnet' | 'devnet';

  private readonly retryOptions = {
    retries: 5,
    minTimeout: 500,
    maxTimeout: 10000,
  };

  constructor(private readonly endpoint: string) {
    this.cluster = endpoint.includes('mainnet') ? 'mainnet' : 'devnet';
    this.startMemoryMonitoring();
  }

  private async getConnection(): Promise<ConnectionPool> {
    // Try to find an available connection
    const availableConnection = this.pool.find(conn => !conn.inUse);
    if (availableConnection) {
      availableConnection.inUse = true;
      availableConnection.lastUsed = Date.now();
      return availableConnection;
    }

    // Create new connection if pool is not full
    if (this.pool.length < this.maxPoolSize) {
      const newConnection: ConnectionPool = {
        v1: new web3.Connection(this.endpoint),
        v2: web3v2.createSolanaRpc(this.endpoint),
        lastUsed: Date.now(),
        inUse: true,
      };
      this.pool.push(newConnection);
      return newConnection;
    }

    // Queue the request if pool is full
    if (this.connectionQueue.length >= this.maxQueueSize) {
      throw new Error('Connection queue is full');
    }

    return new Promise((resolve, reject) => {
      const request: ConnectionRequest = {
        resolve,
        reject,
        timestamp: Date.now(),
      };
      this.connectionQueue.push(request);
      this.processConnectionQueue();
    });
  }

  private processConnectionQueue() {
    const now = Date.now();

    // Clean up timed out requests
    this.connectionQueue = this.connectionQueue.filter(request => {
      if (now - request.timestamp > this.requestTimeout) {
        request.reject(new Error('Connection request timed out'));
        return false;
      }
      return true;
    });

    // Process queue if there are available connections
    const availableConnection = this.pool.find(conn => !conn.inUse);
    if (availableConnection && this.connectionQueue.length > 0) {
      const request = this.connectionQueue.shift();
      if (request) {
        availableConnection.inUse = true;
        availableConnection.lastUsed = now;
        request.resolve(availableConnection);
      }
    }

    // Schedule next queue processing with exponential backoff
    if (this.connectionQueue.length > 0) {
      const backoffTime = Math.min(1000 * Math.pow(2, this.connectionQueue.length - 1), 30000);
      setTimeout(() => this.processConnectionQueue(), backoffTime);
    }
  }

  private releaseConnection(connection: ConnectionPool) {
    connection.inUse = false;
    this.processConnectionQueue(); // Process queue when a connection is released
  }

  private cleanupIdleConnections() {
    const now = Date.now();
    this.pool = this.pool.filter(conn =>
      conn.inUse || now - conn.lastUsed <= this.poolTimeout
    );
  }

  private startMemoryMonitoring() {
    this.memoryUsageInterval = setInterval(() => {
      const memoryUsage = process.memoryUsage();
      logger.info('Memory usage', {
        heapUsed: memoryUsage.heapUsed / 1024 / 1024,
        heapTotal: memoryUsage.heapTotal / 1024 / 1024,
        rss: memoryUsage.rss / 1024 / 1024,
        tags: ['memory-monitor', 'rpc-client'],
        timestamp: new Date().toISOString()
      });
    }, 60000); // Log every minute
  }

  async cleanup() {
    // Clear memory monitoring interval
    if (this.memoryUsageInterval) {
      clearInterval(this.memoryUsageInterval);
      this.memoryUsageInterval = null;
    }

    // Reject all queued requests
    this.connectionQueue.forEach(request => {
      request.reject(new Error('Client is shutting down'));
    });
    this.connectionQueue = [];

    // Cleanup all connections
    this.pool = [];
  }

  async getNFTOwnerByMintAddress(mintAddress: string): Promise<string | null> {
    const connection = await this.getConnection();
    try {
      const data = await retry(this.retryOptions, async () => {
        const res: Response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'RPCClient.getNFTOwnerByMintAddress',
            method: 'getTokenAccounts',
            params: {
              mint: mintAddress,
              page: 1,
              limit: 1,
              options: {},
            },
          }),
        });
        if (res.status == 429 || res.status > 500) {
          const msg = `rpc server error: ${res.status}`;
          logger.warn(msg);
          throw new Error(msg);
        }
        const result = await res.json() as { error?: { message: string }; result?: { token_accounts: Array<{ amount: number; owner: string }> } };
        if (result?.error?.message.includes('Method not found')) {
          logger.warn(`NFT mint ${mintAddress} owner not found`, result);
          return null;
        }
        return result;
      });

      if (data?.error) {
        const msg = `rpc server error: ${data.error.message ?? JSON.stringify(data.error)}`;
        logger.error(`rpc server error`, { ...data });
        throw new Error(msg);
      }
      if (data?.result?.token_accounts) {
        for (const tokenAccount of data.result.token_accounts) {
          if (tokenAccount.amount == 1) {
            return tokenAccount.owner;
          }
        }
        logger.warn(`NFT mint ${mintAddress} owner not found`);
      }
      return null;
    } finally {
      this.releaseConnection(connection);
    }
  }

  async getTokenSupply(mintAddress: web3.PublicKey): Promise<web3.TokenAmount> {
    const connection = await this.getConnection();
    try {
      return retry(this.retryOptions, () => {
        return connection.v1.getTokenSupply(mintAddress).then((res: { value: web3.TokenAmount }) => res.value);
      });
    } finally {
      this.releaseConnection(connection);
    }
  }
}
