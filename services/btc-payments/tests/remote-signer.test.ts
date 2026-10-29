import { createServer } from 'node:http';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as btc from '@scure/btc-signer';
import { afterEach, describe, expect, it } from 'vitest';
import { hdVersionsForNetwork, networkFor } from '../src/adapters/hd/derivation.js';
import { BtcLocalSigner } from '../src/adapters/signer/local.js';
import { BtcRemoteSigner } from '../src/adapters/signer/remote.js';
import { TEST_MNEMONIC } from './helpers.js';

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

async function startServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('sem porta');
  servers.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return `http://127.0.0.1:${address.port}`;
}

function buildFixture() {
  const seed = mnemonicToSeedSync(TEST_MNEMONIC);
  const account = HDKey.fromMasterSeed(seed, hdVersionsForNetwork('regtest')).derive(
    "m/84'/0'/0'",
  );
  const child = account.derive('m/0/0');
  const net = networkFor('regtest');
  const payment = btc.p2wpkh(child.publicKey!, net);
  const tx = new btc.Transaction();
  tx.addInput({
    txid: '11'.repeat(32),
    index: 0,
    witnessUtxo: { script: payment.script, amount: 100_000n },
    sequence: 0xfffffffd,
  });
  tx.addOutputAddress(
    'bcrt1qnjg0jd8228aq7egyzacy8cys3knf9xvr3v5hfj',
    99_000n,
    net,
  );
  return {
    signer: BtcLocalSigner.fromAccountXprv(
      account.privateExtendedKey!,
      'regtest',
    ),
    psbt: hex.encode(tx.toPSBT()),
  };
}

describe('remote signer', () => {
  it('envia PSBT e devolve rawTx/txid assinados', async () => {
    const { signer, psbt } = buildFixture();
    const local = await signer.signSweep({
      psbt,
      inputs: [{ addressIndex: 0 }],
      network: 'regtest',
    });
    if (local.kind !== 'signed') throw new Error('local nao assinou');

    const url = await startServer((req, res) => {
      if (req.url !== '/sign') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ psbt: local.psbt }));
    });

    const remote = new BtcRemoteSigner({ url, token: 'token', timeoutMs: 2_000 });
    const result = await remote.signSweep({
      psbt,
      inputs: [{ addressIndex: 0 }],
      network: 'regtest',
    });
    expect(result.kind).toBe('signed');
    if (result.kind !== 'signed') return;
    expect(result.txid).toBe(local.txid);
    expect(result.rawTx).toBe(local.rawTx);
  });

  it('falha quando o remote responde erro', async () => {
    const { psbt } = buildFixture();
    const url = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const remote = new BtcRemoteSigner({ url, timeoutMs: 2_000 });
    await expect(
      remote.signSweep({
        psbt,
        inputs: [{ addressIndex: 0 }],
        network: 'regtest',
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
