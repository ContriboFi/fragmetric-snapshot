import Module from 'module';

const originalRequire = Module.prototype.require;
let isPatched = false;

// monkey-patch Node.js' require function to control how @solana/web.js dependencies are resolved.
const web3jsV1DependantsPattern = new RegExp(
  [
    '@fragmetric-labs/sdk',
    '@project-serum/anchor',
    '@project-serum/borsh',
    '@coral-xyz/anchor',
    '@coral-xyz/borsh',
    '@raydium-io/raydium-sdk-v2',
    '@kamino-finance/kliquidity-sdk',
    '@kamino-finance/klend-sdk',
    '@kamino-finance/farms-sdk',
    '@kamino-finance/scope-sdk',
    '@solana/spl-token',
    '@orca-so/whirlpool-sdk',
    '@orca-so/whirlpool-client-sdk',
    '@hubbleprotocol/hubble-config',
    '@meteora-ag',
    '@mercurial-finance',
    '@metaplex-foundation',
    '@solana/buffer-layout-utils',
  ]
    .map((token) => token.replace(/[@/]/g, '\\$&'))
    .join('|'),
);

export function patchRequire() {
  if (isPatched) {
    return;
  }

  Module.prototype.require = function (moduleName: string) {
    if (moduleName == '@solana/web3.js') {
      const stacktrace = new Error().stack ?? '';
      if (web3jsV1DependantsPattern.test(stacktrace)) {
        return originalRequire.call(this, '@solana/web3.js-1');
      } else {
        return originalRequire.call(this, '@solana/web3.js-2');
      }
    }
    return originalRequire.call(this, moduleName);
  };

  isPatched = true;
}

export function unpatchRequire() {
  if (!isPatched) {
    return;
  }

  Module.prototype.require = originalRequire;
  isPatched = false;
}

// Auto-patch on import
patchRequire();

// Cleanup on process exit
process.on('exit', () => {
  unpatchRequire();
});
