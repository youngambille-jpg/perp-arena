#!/usr/bin/env bash
#
# Enroll a Perpl testnet API key from your own machine.
#
# Why local: Perpl geo-blocks the enrollment endpoint from some
# datacenter IPs (HTTP 451). Running this where you live avoids that.
#
# What it does:
#   1. Generates an Ed25519 API keypair locally (never leaves the machine).
#   2. Fetches the EIP-712 enrollment payload from Perpl testnet.
#   3. Shows you the statement and asks for explicit confirmation.
#   4. Signs it with YOUR wallet key (hidden prompt, testnet only).
#   5. Enrolls, saves credentials to ./perpl-testnet-key.json (0600),
#      and verifies the key with a signed request.
#
# Requirements: node >= 18, npm, curl. Installs ethers + @noble/ed25519
# into a temp dir (deleted afterwards).
#
# SECURITY: use a throwaway testnet wallet. Never paste a mainnet key here.

set -euo pipefail

PERPL_API_URL="https://testnet.perpl.xyz/api"
CHAIN_ID=10143
OUT_FILE="./perpl-testnet-key.json"

echo "=== Perpl testnet API-key enrollment ==="
echo "Network: Monad testnet (chain $CHAIN_ID)"
echo

# ---- prerequisites ---------------------------------------------------------
command -v node >/dev/null || { echo "ERROR: node >= 18 required"; exit 1; }
command -v npm >/dev/null || { echo "ERROR: npm required"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: node >= 18 required (found $(node -v))"
  exit 1
fi

echo "WARNING: this handles a wallet private key in memory."
echo "Use a TESTNET-ONLY wallet. Never use a mainnet key with real funds."
echo
read -r -s -p "Wallet private key (0x…, input hidden): " WALLET_KEY
echo
if ! [[ "$WALLET_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "ERROR: expected 0x followed by 64 hex characters"
  exit 1
fi

read -r -p "Key label [perpl-arena-testnet]: " LABEL
LABEL="${LABEL:-perpl-arena-testnet}"
read -r -p "Scope (1=read, 2=trade, 3=both) [3]: " SCOPE
SCOPE="${SCOPE:-3}"
if ! [[ "$SCOPE" =~ ^[123]$ ]]; then
  echo "ERROR: scope must be 1, 2, or 3"
  exit 1
fi
export WALLET_KEY LABEL SCOPE PERPL_API_URL CHAIN_ID OUT_FILE

# ---- workdir with npm deps ---------------------------------------------------
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
(
  cd "$WORKDIR"
  npm init -y >/dev/null 2>&1
  npm install --no-audit --no-fund ethers@6 @noble/ed25519@2 >/dev/null 2>&1
)

cat > "$WORKDIR/enroll.mjs" <<'EOF'
import { ethers } from 'ethers';
import * as ed from '@noble/ed25519';

const {
  WALLET_KEY,
  LABEL,
  SCOPE,
  PERPL_API_URL,
  CHAIN_ID,
  OUT_FILE,
} = process.env;

const wallet = new ethers.Wallet(WALLET_KEY);
console.log('Wallet address:', wallet.address);

// 1. Fresh Ed25519 API keypair (stays on this machine).
const apiPriv = ed.utils.randomPrivateKey();
const apiPub = await ed.getPublicKeyAsync(apiPriv);
const publicKeyHex = '0x' + Buffer.from(apiPub).toString('hex');
const privateKeyHex = '0x' + Buffer.from(apiPriv).toString('hex');
console.log('API public key:', publicKeyHex);

// 2. Enrollment payload.
const payloadRes = await fetch(`${PERPL_API_URL}/v1/api-key/payload`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chain_id: Number(CHAIN_ID),
    address: wallet.address,
    public_key: publicKeyHex,
    scope_mask: Number(SCOPE),
    label: LABEL,
  }),
});
if (!payloadRes.ok) {
  console.error(
    `Payload request failed: HTTP ${payloadRes.status} ${(await payloadRes.text()).slice(0, 200)}`,
  );
  if (payloadRes.status === 451) {
    console.error('Perpl blocks enrollment from this IP/region. Try another network.');
  }
  process.exit(1);
}
const { typed_data: typedData, mac } = await payloadRes.json();

// 3. Show the statement; require explicit confirmation.
const statement = typedData?.message?.statement ?? '(no statement returned)';
console.log('\n--- Perpl asks your wallet to sign this ---\n' + statement + '\n---');
const answer = await new Promise((resolve) => {
  // Non-interactive stdin (piped): take the answer from CONFIRM=y.
  if (!process.stdin.isTTY) {
    resolve((process.env.CONFIRM ?? 'n').toLowerCase());
    return;
  }
  process.stdout.write('Sign and enroll? [y/N]: ');
  process.stdin.once('data', (d) => resolve(d.toString().trim().toLowerCase()));
});
if (answer !== 'y') {
  console.log('Aborted. Nothing was enrolled.');
  process.exit(0);
}

// 4a. Wallet secp256k1 EIP-712 signature (ethers drops EIP712Domain).
const { EIP712Domain, ...types } = typedData.types;
const signature = await wallet.signTypedData(
  typedData.domain,
  types,
  typedData.message,
);

// 4b. Ed25519 proof-of-possession over the EIP-712 digest.
const digest = ethers.TypedDataEncoder.hash(
  typedData.domain,
  types,
  typedData.message,
);
const popSig = await ed.signAsync(ethers.getBytes(digest), apiPriv);
const popSignature = '0x' + Buffer.from(popSig).toString('hex');

// 5. Enroll.
const enrollRes = await fetch(`${PERPL_API_URL}/v1/api-key/enroll`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chain_id: Number(CHAIN_ID),
    address: wallet.address,
    typed_data: typedData,
    mac,
    signature,
    pop_signature: popSignature,
  }),
});
if (!enrollRes.ok) {
  let hint = '';
  if (enrollRes.status === 404) {
    hint =
      '\n404 means this wallet has no on-chain Perpl account yet. ' +
      'Create it FIRST, then re-run this script (it generates a fresh key each run):\n' +
      '  1. Open https://testnet.perpl.xyz with the SAME wallet.\n' +
      '  2. Get test funds from the faucet and deposit >= 100 aUSD collateral\n' +
      '     (this creates the on-chain account via createAccount).\n' +
      '  3. Re-run this script and enroll again.';
  } else if (enrollRes.status === 409) {
    hint =
      ' (public key already registered — this script always generates a fresh one, so do not reuse)';
  } else if (enrollRes.status === 423) {
    hint =
      ' (per-profile key limit reached: revoke a key at https://testnet.perpl.xyz/apikeys)';
  }
  console.error(
    `Enroll failed: HTTP ${enrollRes.status} ${(await enrollRes.text()).slice(0, 200)}${hint}`,
  );
  process.exit(1);
}
const enrolled = await enrollRes.json();
const apiKey = enrolled.api_key ?? enrolled.apiKey;
if (!apiKey) {
  console.error('Enroll response had no api_key token:', JSON.stringify(enrolled).slice(0, 200));
  process.exit(1);
}

// 6. Save credentials (owner-only permissions).
const { writeFileSync, chmodSync } = await import('node:fs');
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      chain_id: Number(CHAIN_ID),
      address: wallet.address,
      label: LABEL,
      scope_mask: enrolled.scope_mask,
      api_key: apiKey,
      api_key_secret: privateKeyHex,
      public_key: publicKeyHex,
      enrolled_at: new Date().toISOString(),
    },
    null,
    2,
  ),
);
chmodSync(OUT_FILE, 0o600);
console.log(`\nEnrolled. Credentials saved to ${OUT_FILE} (mode 0600).`);

// 7. Verify with a signed request. 404 = key valid, no on-chain
// account yet (expected). 200 = account exists. 401 = signing problem.
import { createHash, randomBytes } from 'node:crypto';
const target = '/v1/trading/fills?count=1';
const timestamp = Date.now().toString();
const nonce = randomBytes(16).toString('base64url');
const bodyHash = createHash('sha256').update('').digest('hex');
const canonical = [Number(CHAIN_ID), 'GET', target, timestamp, nonce, bodyHash].join('\n');
const sig = await ed.signAsync(
  Buffer.from(canonical),
  Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex'),
);
const verify = await fetch(`${PERPL_API_URL}${target}`, {
  headers: {
    'X-API-Key': apiKey,
    'X-API-Timestamp': timestamp,
    'X-API-Nonce': nonce,
    'X-API-Signature': Buffer.from(sig).toString('base64url'),
  },
});
if (verify.status === 404) {
  console.log('Key VERIFIED (404: valid key, no on-chain exchange account yet).');
} else if (verify.status === 200) {
  console.log('Key VERIFIED (200: exchange account exists, ready to trade).');
} else {
  console.log(`Verify returned HTTP ${verify.status}: ${(await verify.text()).slice(0, 120)}`);
}
EOF

node "$WORKDIR/enroll.mjs"

# ---- clear secrets from this shell --------------------------------------------
unset WALLET_KEY
echo
echo "Next steps (in this order):"
echo "  1. If enroll failed with 404: create the on-chain account first —"
echo "     testnet.perpl.xyz with the same wallet, faucet + deposit >= 100 aUSD —"
echo "     then re-run this script."
echo "  2. Import into perpl-arena: POST /accounts/import with api_key +"
echo "     api_key_secret from $OUT_FILE (address, scope_mask 3, a label)."
echo "  3. The worker opens a trading session automatically."
