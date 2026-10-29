import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { describe, expect, it } from 'vitest';
import { assertSweepTransaction } from '../src/services/sweep-service.js';

const cold = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
const txid = '0123456789abcdef'.repeat(4);

function rawPaying(address: string, output: bigint): string {
  const network = btc.NETWORK;
  const decoded = btc.Address(network).decode(cold);
  const tx = new btc.Transaction();
  tx.addInput({
    txid,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: {
      script: btc.OutScript.encode(decoded),
      amount: 10_000n,
    },
  });
  tx.addOutputAddress(address, output, network);
  return hex.encode(tx.toBytes(true));
}

describe('assertSweepTransaction', () => {
  it('aceita o raw que gasta o input certo para a carteira fria', () => {
    expect(() =>
      assertSweepTransaction({
        rawTx: rawPaying(cold, 9_000n),
        inputs: [{ txid, vout: 0, amountSats: '10000' }],
        coldWallet: cold,
        networkName: 'bitcoin',
        maxFeePct: 0.1,
      }),
    ).not.toThrow();
  });

  it('recusa destino diferente e taxa acima do limite', () => {
    const other = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    expect(() =>
      assertSweepTransaction({
        rawTx: rawPaying(other, 9_000n),
        inputs: [{ txid, vout: 0, amountSats: '10000' }],
        coldWallet: cold,
        networkName: 'bitcoin',
        maxFeePct: 0.1,
      }),
    ).toThrow(/carteira fria/);
    expect(() =>
      assertSweepTransaction({
        rawTx: rawPaying(cold, 1_000n),
        inputs: [{ txid, vout: 0, amountSats: '10000' }],
        coldWallet: cold,
        networkName: 'bitcoin',
        maxFeePct: 0.1,
      }),
    ).toThrow(/taxa/);
  });
});
