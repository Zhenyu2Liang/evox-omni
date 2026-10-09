import { readFileSync, writeFileSync } from 'node:fs';

const file = 'tests/unit/banking-sdk/atomicity.test.ts';
let src = readFileSync(file, 'utf8');

// 1) Add the shared failure-injection helper import (after the fixtures import).
const anchor = "import { DEMO_USER_ID } from '../../helpers/fixtures';";
if (src.split(anchor).length !== 2) throw new Error('fixtures-import anchor not unique/found');
if (src.includes("helpers/write-failure")) throw new Error('write-failure import already present');
const importLine = "import { withInjectedWriteFailure } from '../../helpers/write-failure';";
src = src.replace(anchor, `${anchor}\r\n${importLine}`);

// 2) Delete the now-shared local injection block (Proxy helper + withInjectedWriteFailure).
const block = /\/\* -+ write-failure injection \*\/[\s\S]*?\n\}\r\n\r\n\/\* -+ tests \*\//;
const matches = src.match(new RegExp(block.source, 'g'));
if (!matches || matches.length !== 1) throw new Error(`injection block not uniquely matched (${matches?.length})`);
src = src.replace(block, '/* ---------------------------------------------------------------------- tests */');

if (src.includes('function injectWriteFailure') || src.includes('type FailureThrower') || src.includes('interface TxRunner')) {
  throw new Error('injection block left residue');
}
if (!src.includes('withInjectedWriteFailure(')) throw new Error('withInjectedWriteFailure usage disappeared');

writeFileSync(file, src, 'utf8');
console.log('OK', src.split('\r\n').length, 'lines');
