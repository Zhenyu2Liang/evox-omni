import fs from 'node:fs';

const YEN = String.fromCharCode(0xa5); // ¥
const SECTION = String.fromCharCode(0xa7); // §
const file = 'tests/helpers/fixtures.ts';
const original = fs.readFileSync(file, 'utf8');
const hadCRLF = original.includes('\r\n');
let text = original.split('\r\n').join('\n');

const from = `either (${SECTION}5,800)`;
const to = `either (${YEN}5,800)`;
if (text.indexOf(from) === -1) throw new Error('old text not found');
if (text.indexOf(from, text.indexOf(from) + 1) !== -1) throw new Error('old text not unique');
text = text.replace(from, to);

fs.writeFileSync(file, hadCRLF ? text.split('\n').join('\r\n') : text, 'utf8');
console.log('fixed currency symbol');
