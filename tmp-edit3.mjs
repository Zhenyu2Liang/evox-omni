import { readFileSync, writeFileSync } from 'node:fs';

const file = 'tests/integration/standalone-recovery.test.ts';
let src = readFileSync(file, 'utf8');

// 1) The `set_card_limit` wedge case asserted an ABSOLUTE ledger-row count (30) — a fixture-shape
//    assumption. Capture the count before the repeat instead, so the assertion keeps its intent
//    ("the repeat caused NO ledger movement") without hard-coding the seeded row total.
const before = `  await p.cardLimit.updateMany({ where: limitWhere, data: { amount: 500 } });\r\n\r\n  const repeated = await confirmRaw(id, s);`;
if (src.split(before).length !== 2) throw new Error('card-limit anchor not unique/found');
src = src.replace(
  before,
  `  await p.cardLimit.updateMany({ where: limitWhere, data: { amount: 500 } });\r\n\r\n  const txBeforeRepeat = await p.transaction.count({ where: { userId } });\r\n  const repeated = await confirmRaw(id, s);`,
);

const abs = 'expect(txAfter).toBe(30); // no ledger movement';
if (src.split(abs).length !== 2) throw new Error('absolute-count assertion not unique/found');
src = src.replace(abs, 'expect(txAfter).toBe(txBeforeRepeat); // no ledger movement');

if (src.includes('toBe(30)')) throw new Error('absolute fixture count still present');
writeFileSync(file, src, 'utf8');
console.log('OK');
