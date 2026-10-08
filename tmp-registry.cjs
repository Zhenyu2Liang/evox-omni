const fs = require('fs');
let out = [];
try {
  const pi = require('@mariozechner/pi-ai');
  const ids = (pi.getModels && pi.getModels('deepseek') || []).map(m => m.id);
  out.push('deepseek ids: ' + JSON.stringify(ids));
  out.push('deepseek-flash registered? ' + ids.includes('deepseek-flash'));
  out.push('deepseek-v4-flash registered? ' + ids.includes('deepseek-v4-flash'));
  const reg = (pi.getModels('deepseek')||[]).find(x=>x.id==='deepseek-v4-flash');
  if (reg) out.push('v4-flash baseUrl=' + reg.baseUrl + ' api=' + reg.api);
} catch (e) { out.push('ERROR ' + (e && e.stack || e)); }
fs.writeFileSync('tmp-registry-out.txt', out.join('\n'));
