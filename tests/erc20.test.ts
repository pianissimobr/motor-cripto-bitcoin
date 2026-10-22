import { describe, expect, it } from 'vitest';
import { TRANSFER_TOPIC, decodeTransferLog, encodeTransfer } from '../src/core/chain/erc20.js';
import { Interface } from 'ethers';

const iface = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

describe('ERC-20', () => {
  it('usa o topic padrao do Transfer', () => {
    expect(TRANSFER_TOPIC).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    );
  });

  it('codifica transfer de forma interoperavel', () => {
    const data = encodeTransfer('0xB528b506718d18eB4Ab7EC6ca42a47C7740022b6', 1_000_000n);
    const decoded = iface.decodeFunctionData('transfer', data);
    expect(decoded[0]).toBe('0xB528b506718d18eB4Ab7EC6ca42a47C7740022b6');
    expect(decoded[1]).toBe(1_000_000n);
  });

  it('decodifica um log de Transfer', () => {
    const log = iface.encodeEventLog(iface.getEvent('Transfer')!, [
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      22_221_000n,
    ]);
    const decoded = decodeTransferLog(log);
    expect(decoded?.from).toBe('0x1111111111111111111111111111111111111111');
    expect(decoded?.to).toBe('0x2222222222222222222222222222222222222222');
    expect(decoded?.value).toBe(22_221_000n);
  });

  it('devolve null para log invalido', () => {
    expect(decodeTransferLog({ topics: [], data: '0x' })).toBeNull();
  });
});
