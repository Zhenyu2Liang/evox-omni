import { expect, it } from 'vitest';
import { businessProse, hasOperationClaim, hasBalanceClaim, operationExplanation } from './reply-safety';

it.each(['转账 ¥200.00 的操作已提交，正在等待你的确认。', '已经给张伟转账200元。',
  'Your transfer has been submitted.', 'Transfer submitted.', 'I have transferred 200 yuan.', 'Transferred 200 yuan.'])
('recognizes current-operation assertions without depending on an intent declaration: %s', prose => {
  expect(hasOperationClaim(prose)).toBe(true);
});

it.each(['An example payment succeeded; that is only an example.', 'You said the transfer was submitted earlier.',
  '历史记录中的原话是“转账已提交”。', 'A negative amount of -10 is invalid.', 'The transfer has not been submitted.',
  '转账尚未提交，请补充金额。', '是否已经完成转账？'])
('preserves examples, history, questions, invalid amounts and truthful non-submission: %s', prose => {
  expect(hasOperationClaim(prose)).toBe(false);
  expect(operationExplanation(prose)).toBe(prose);
});

it('retains useful independent instructions while removing a fabricated old pending state', () => {
  const prose = "Deleting a card record is available on the Cards page.\n\nYour virtual card application is waiting for confirmation and verification.";
  expect(hasOperationClaim(prose)).toBe(true);
  expect(operationExplanation(prose)).toBe('Deleting a card record is available on the Cards page.');
});

it('uses business labels without rewriting explicitly requested protocol examples', () => {
  const prose = 'REMINDER / PAYMENT / TRANSFER, sourceAccountId';
  expect(businessProse(prose)).toBe('提醒 / 缴费 / 转账, 付款账户');
  expect(businessProse(prose, true)).toBe(prose);
});

it('distinguishes concrete balance assertions from conditional advice and quoted examples', () => {
  expect(hasBalanceClaim('你的账户余额为 ¥999,999.00。')).toBe(true);
  expect(hasBalanceClaim('Your balance is 999999.99 CNY.')).toBe(true);
  expect(hasBalanceClaim('If your balance is 100, you can consider that option.')).toBe(false);
  expect(hasBalanceClaim('假设余额为 100 元。')).toBe(false);
  expect(hasBalanceClaim('A negative transfer amount is invalid.')).toBe(false);
});

it('does not confuse realized profit or a possible future redemption with a completed redemption', () => {
  for (const prose of ['全部持仓都没有已实现的收益（累计收益等于持仓收益），说明期间未做过部分赎回。',
    '持仓已到期，可以按份额赎回。', '没有已经提交的转账。', '如果转账已经完成，可以查看回执。',
    '- 如果转账已经完成，可以查看回执。']) {
    expect(hasOperationClaim(prose)).toBe(false);
    expect(operationExplanation(prose)).toBe(prose);
  }
  expect(hasOperationClaim('已向陈未央转账200元。')).toBe(true);
});
