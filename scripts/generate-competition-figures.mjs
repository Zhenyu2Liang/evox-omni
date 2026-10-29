import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Keep diagram sources reproducible without a diagram service or raster assets.
const destination = new URL('../docs/competition/figures/', import.meta.url);
const ink = '#000000';
const stroke = '#64748B';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

class Figure {
  constructor(name, width, height, title, description, lineColor = stroke, fontSize = 28, { arrowSize = 12, lineWidth = 2 } = {}) {
    Object.assign(this, { name, width, height, lineColor, fontSize });
    this.textSpaces = [];
    this.parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
      `<title id="title">${escape(title)}</title>`,
      `<desc id="desc">${escape(description)}</desc>`,
      `<defs><style>text{font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;fill:${ink}}.wire{fill:none;stroke:${lineColor};stroke-width:${lineWidth};stroke-linecap:round;stroke-linejoin:round}.node{fill:none;stroke:${lineColor};stroke-width:2}</style>`,
      `<marker id="arrow" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="${arrowSize}" markerHeight="${arrowSize}" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1 1 L11 6 L1 11 L4 6 Z" fill="${lineColor}"/></marker></defs>`,
    ];
  }

  text(x, y, text, { anchor = 'middle', weight = 400 } = {}) {
    const size = this.fontSize;
    this.parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" style="fill:${ink}">${escape(text)}</text>`);
    const width = [...text].reduce((sum, character) => sum + (character.codePointAt(0) > 255 ? 1 : 0.6), 0) * size;
    const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
    this.textSpaces.push(`<rect x="${left - 6}" y="${y - size - 3}" width="${width + 12}" height="${size + 12}" fill="black"/>`);
  }

  rect(x, y, width, height, radius = 12, dashed = false) {
    this.parts.push(`<rect class="node" x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"${dashed ? ' stroke-dasharray="8 8"' : ''}/>`);
  }

  path(d, { arrow = true, dashed = false, both = false, opacity = 1, maskText = false } = {}) {
    this.parts.push(`<path class="wire" d="${d}"${arrow ? ' marker-end="url(#arrow)"' : ''}${both ? ' marker-start="url(#arrow)"' : ''}${dashed ? ' stroke-dasharray="8 8"' : ''}${opacity !== 1 ? ` opacity="${opacity}"` : ''}${maskText ? ' mask="url(#text-space)"' : ''}/>`);
  }

  node(x, y, width, height, title, detail = []) {
    this.rect(x, y, width, height);
    const lines = Array.isArray(detail) ? detail : [detail];
    const lineHeight = 40;
    const firstBaseline = y + height / 2 + 10 - lines.length * lineHeight / 2;
    this.text(x + width / 2, firstBaseline, title, { weight: 600 });
    lines.forEach((line, i) => this.text(x + width / 2, firstBaseline + (i + 1) * lineHeight, line));
  }

  diamond(cx, cy, rx, ry, lines, theme = null) {
    const style = theme ? ` style="fill:${theme.fill};stroke:${theme.edge}"` : '';
    this.parts.push(`<path class="node" d="M${cx} ${cy - ry} L${cx + rx} ${cy} L${cx} ${cy + ry} L${cx - rx} ${cy} Z"${style}/>`);
    lines.forEach((line, i) => this.text(cx, cy - (lines.length - 1) * 20 + i * 40 + 9, line, { weight: 600 }));
  }

  async save() {
    if (this.parts.some(part => part.includes('mask="url(#text-space)"'))) {
      this.parts.push(`<defs><mask id="text-space" maskUnits="userSpaceOnUse" x="0" y="0" width="${this.width}" height="${this.height}"><rect width="${this.width}" height="${this.height}" fill="white"/>${this.textSpaces.join('')}</mask></defs>`);
    }
    await writeFile(new URL(this.name, destination), `${this.parts.join('\n')}\n</svg>\n`);
    console.log(`${this.name}: ${this.width} × ${this.height}`);
  }
}

async function createDiagramStyle(f) {
  const colors = {
    interface: { edge: '#487B9A', fill: '#ECF4F8' },
    intelligence: { edge: '#787499', fill: '#F0EFF7' },
    authorization: { edge: '#B28A4E', fill: '#FBF4E7' },
    banking: { edge: '#3D8277', fill: '#EDF6F1' },
    neutral: { edge: '#87939B', fill: '#F2F4F5' },
  };
  const wechatSvg = await readFile(new URL('assets/wechat.svg', destination), 'utf8');
  const wechatPath = wechatSvg.match(/<path d="([^"]+)"/)[1];
  f.parts.push('<defs><marker id="response-arrow" viewBox="0 0 24 24" refX="23" refY="12" markerWidth="24" markerHeight="24" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L23 12 L1 23 L6 12 Z" fill="#4D8CA9"/></marker><linearGradient id="browser-surface" x2="0" y2="1"><stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#E7F1F7"/></linearGradient><linearGradient id="robot-surface" x2="0" y2="1"><stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#DDD9EF"/></linearGradient><linearGradient id="bank-surface" x2="0" y2="1"><stop stop-color="#E3F3EB"/><stop offset="1" stop-color="#A9CFC0"/></linearGradient></defs>');

  function frame(x, y, width, height, roleName, fill, radius = 14) {
    const role = colors[roleName];
    f.parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill ?? role.fill}" stroke="${role.edge}" stroke-width="2.4"/>`);
  }

  function label(x, y, text, { anchor = 'middle', weight = 600 } = {}) {
    f.text(x, y, text, { anchor, weight });
  }

  function illustration(name, x, y, size = 100) {
    if (name === 'wechat') {
      const art = `<ellipse cx="49" cy="91" rx="43" ry="5" fill="#173B28" opacity=".09"/><rect x="68" y="14" width="27" height="63" rx="6" fill="#FFFFFF" stroke="#2C8A58" stroke-width="2"/><path d="M75 21 H88 M78 69 H85" stroke="#77AD8E" stroke-width="2" stroke-linecap="round"/><rect x="2" y="3" width="76" height="76" rx="19" fill="#07C160"/><g transform="translate(12 13) scale(2.333333)"><path d="${wechatPath}" fill="#FFFFFF"/></g>`;
      f.parts.push(`<g transform="translate(${x} ${y}) scale(${size / 100})">${art}</g>`);
      return;
    }
    const shapes = {
      user: '<ellipse cx="50" cy="96" rx="36" ry="4" fill="#18394B" opacity=".09"/><path d="M43 49 H57 V68 H43Z" fill="#E9C3A8"/><ellipse cx="50" cy="31" rx="19" ry="23" fill="#F2D3BC"/><path d="M30 28 Q27 7 47 5 Q68 4 71 23 L66 34 L62 22 Q43 27 35 18 L34 33Z" fill="#40576C"/><path d="M15 94 V82 Q15 65 38 60 L50 69 L62 60 Q85 65 85 82 V94Z" fill="#83ABC1"/><path d="M38 60 L50 69 L45 78 L32 65 M62 60 L50 69 L55 78 L68 65" fill="#FFFFFF"/><path d="M22 80 V94 M78 80 V94" stroke="#487B9A" stroke-width="2"/><circle cx="43" cy="33" r="1.7" fill="#40576C"/><circle cx="57" cy="33" r="1.7" fill="#40576C"/><path d="M44 43 Q50 47 56 43" fill="none" stroke="#C38E73" stroke-width="2" stroke-linecap="round"/>',
      web: '<ellipse cx="50" cy="91" rx="43" ry="5" fill="#18394B" opacity=".09"/><rect x="16" y="15" width="78" height="61" rx="7" fill="#BDD6E4"/><path d="M40 67 V82 H27 V87 H72 V82 H60 V67" fill="#D5E5ED" stroke="#487B9A" stroke-width="2"/><rect x="5" y="5" width="82" height="64" rx="7" fill="url(#browser-surface)" stroke="#487B9A" stroke-width="2"/><path d="M5 12 Q5 5 12 5 H80 Q87 5 87 12 V22 H5 Z" fill="#487B9A"/><g fill="#FFFFFF" opacity=".85"><circle cx="14" cy="14" r="2"/><circle cx="22" cy="14" r="2"/><circle cx="30" cy="14" r="2"/></g><rect x="15" y="31" width="29" height="27" rx="4" fill="#D4E7F1"/><path d="M20 51 L27 43 L33 47 L39 37 M53 34 H76 M53 44 H72 M53 54 H66" fill="none" stroke="#487B9A" stroke-width="2.5" stroke-linecap="round"/>',
      api: '<ellipse cx="50" cy="92" rx="42" ry="4" fill="#18394B" opacity=".08"/><path d="M50 25 V75 M22 50 H78" stroke="#7DA5BA" stroke-width="4"/><rect x="25" y="9" width="50" height="29" rx="7" fill="#487B9A"/><rect x="5" y="57" width="37" height="28" rx="6" fill="#E0EDF4" stroke="#487B9A" stroke-width="2"/><rect x="58" y="57" width="37" height="28" rx="6" fill="#E0EDF4" stroke="#487B9A" stroke-width="2"/><path d="M37 23 H63 M14 70 H33 M67 70 H86" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/>',
      agent: '<ellipse cx="50" cy="94" rx="39" ry="4" fill="#342B54" opacity=".10"/><path d="M50 9 V21" stroke="#787499" stroke-width="3"/><circle cx="50" cy="7" r="5" fill="#B3A9D8"/><rect x="4" y="37" width="13" height="23" rx="5" fill="#A69AC9"/><rect x="83" y="37" width="13" height="23" rx="5" fill="#A69AC9"/><rect x="13" y="20" width="74" height="57" rx="17" fill="url(#robot-surface)" stroke="#787499" stroke-width="2"/><path d="M28 86 Q28 72 40 72 H60 Q72 72 72 86 Z" fill="#C5BCDF" stroke="#787499" stroke-width="2"/><rect x="23" y="33" width="54" height="30" rx="11" fill="#F8F7FC"/><circle cx="36" cy="46" r="5" fill="#787499"/><circle cx="64" cy="46" r="5" fill="#787499"/><circle cx="37" cy="44" r="1.5" fill="#FFFFFF"/><circle cx="65" cy="44" r="1.5" fill="#FFFFFF"/><path d="M42 59 Q50 64 58 59" fill="none" stroke="#787499" stroke-width="2.5" stroke-linecap="round"/>',
      shield: '<ellipse cx="50" cy="94" rx="35" ry="4" fill="#59401D" opacity=".09"/><path d="M53 8 L91 22 V48 Q91 73 53 94 Q15 73 15 48 V22 Z" fill="#DCC69D"/><path d="M47 3 L84 17 V44 Q84 69 47 89 Q10 69 10 44 V17 Z" fill="#F4E4C3" stroke="#B28A4E" stroke-width="2"/><path d="M47 14 L74 24 V44 Q74 62 47 78 Q20 62 20 44 V24 Z" fill="#FFFFFF" opacity=".84"/><path d="M31 43 L43 55 L65 32" fill="none" stroke="#B28A4E" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>',
      page: '<ellipse cx="50" cy="94" rx="37" ry="4" fill="#18394B" opacity=".08"/><rect x="18" y="9" width="71" height="79" rx="8" fill="#BDD6E4"/><rect x="9" y="3" width="71" height="79" rx="8" fill="url(#browser-surface)" stroke="#487B9A" stroke-width="2"/><path d="M9 11 Q9 3 17 3 H72 Q80 3 80 11 V22 H9 Z" fill="#487B9A"/><circle cx="19" cy="13" r="2" fill="#FFFFFF"/><path d="M21 35 H66 M21 47 H59" stroke="#ACC9D9" stroke-width="5" stroke-linecap="round"/><rect x="21" y="59" width="34" height="12" rx="4" fill="#D8E9F2"/><circle cx="74" cy="73" r="18" fill="#3D8277"/><path d="M65 73 L71 79 L83 66" fill="none" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>',
      bank: '<ellipse cx="50" cy="94" rx="47" ry="4" fill="#1C4437" opacity=".10"/><path d="M7 35 L50 9 L93 35 Z" fill="#3D8277"/><path d="M15 38 H85 V79 H15 Z" fill="url(#bank-surface)"/><path d="M20 41 H30 V79 H20 Z M45 41 H55 V79 H45 Z M70 41 H80 V79 H70 Z" fill="#FFFFFF"/><path d="M7 80 H93 V86 H7 Z M2 87 H98 V93 H2 Z" fill="#3D8277"/><path d="M7 35 H93" stroke="#2C655C" stroke-width="3"/><circle cx="50" cy="26" r="7" fill="#D8E9DA"/>',
      db: '<ellipse cx="50" cy="94" rx="39" ry="4" fill="#1C4437" opacity=".10"/><path d="M12 20 V76 C12 96 88 96 88 76 V20" fill="url(#bank-surface)" stroke="#3D8277" stroke-width="2"/><ellipse cx="50" cy="20" rx="38" ry="14" fill="#E5F4EB" stroke="#3D8277" stroke-width="2"/><path d="M12 46 C12 65 88 65 88 46 M12 68 C12 87 88 87 88 68" fill="none" stroke="#3D8277" stroke-width="2"/><path d="M24 34 V78" stroke="#FFFFFF" stroke-width="4" opacity=".6" stroke-linecap="round"/>',
      transfer: '<path d="M12 30 H79 L65 16 M79 30 L65 44 M88 70 H21 L35 56 M21 70 L35 84" fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>',
      investment: '<path d="M13 15 V86 H90 M25 66 L45 47 L61 55 L87 21 M70 21 H87 V38" fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>',
      card: '<rect x="5" y="19" width="90" height="64" rx="10" fill="#C0E0D5"/><path d="M5 38 H95" stroke="#FFFFFF" stroke-width="10"/><rect x="17" y="58" width="19" height="13" rx="3" fill="#FFFFFF"/><path d="M65 67 H81" stroke="#3D8277" stroke-width="4" stroke-linecap="round"/>',
      budget: '<path d="M14 23 L77 12 V32 H14 Z" fill="#C0E0D5"/><rect x="8" y="29" width="84" height="59" rx="10" fill="none" stroke="#FFFFFF" stroke-width="4"/><path d="M66 46 H93 V72 H66 Q58 72 58 64 V54 Q58 46 66 46Z" fill="#C0E0D5"/><circle cx="72" cy="59" r="4" fill="#3D8277"/>',
    };
    if (!shapes[name]) throw new Error(`Unknown illustration: ${name}`);
    const art = ['transfer', 'investment', 'card', 'budget'].includes(name)
      ? shapes[name].replaceAll('#FFFFFF', '#3D8277')
      : shapes[name];
    f.parts.push(`<g transform="translate(${x} ${y}) scale(${size / 100})">${art}</g>`);
  }

  function bigArrow(x, start, end, right = false) {
    const stem = right ? 9 : 8;
    const head = right ? 22 : 16;
    const wing = right ? 26 : 22;
    const path = right
      ? `M${start} ${x - stem} H${end - head} V${x - wing} L${end} ${x} L${end - head} ${x + wing} V${x + stem} H${start} Z`
      : `M${x - stem} ${start} H${x + stem} V${end - head} H${x + wing} L${x} ${end} L${x - wing} ${end - head} H${x - stem} Z`;
    f.parts.push(`<path d="${path}" fill="#9CAFB9"/>`);
  }

  function response(path) {
    f.parts.push(`<path class="wire" d="${path}" style="stroke:#4D8CA9;stroke-width:4" stroke-dasharray="10 9" marker-end="url(#response-arrow)"/>`);
  }

  function node(x, y, width, height, title, detail = [], { role = 'interface', icon = null, fill = undefined, lineHeight = 40 } = {}) {
    frame(x, y, width, height, role, fill);
    const lines = Array.isArray(detail) ? detail : [detail];
    let center = x + width / 2;
    if (icon) {
      const size = Math.min(64, height - 28);
      illustration(icon, x + 18, y + (height - size) / 2, size);
      center = x + (size + 36 + width - 16) / 2;
    }
    const first = y + height / 2 + 10 - lines.length * lineHeight / 2;
    f.text(center, first, title, { weight: 600 });
    lines.forEach((line, i) => f.text(center, first + (i + 1) * lineHeight, line));
  }

  return { colors, frame, label, illustration, bigArrow, response, node };
}

await mkdir(destination, { recursive: true });

// Group cross-cutting persistence instead of drawing a database wire from every module.
{
  const f = new Figure('system-architecture.svg', 1600, 1760, '系统总体架构（文档版）',
    '按仓库实现绘制的技术组件架构。Web 通过 JSON / SSE，微信通道通过 HTTP JSON 使用 Next.js API。对话进入持久化 Agent 运行时；操作与任务 API 进入确认、验证与工作流控制，页面业务独立校验。Pi Agent Core 使用模型适配器、上下文压缩、工具注册及参数校验；运行日志保存事件、检查点与租约，事件提交后才对外发布。单步工具与 DAG 节点均经过安全网关，受控写入通过命令事务、幂等回执与必需审计执行。运行恢复进程与定时任务调度独立启动，定时付款仍生成需授权的工作流。所有服务使用共享仓储与 Prisma / SQLite 持久化；存储层表示共同依赖，不逐一画出读写连接。双向箭头包含请求与结果返回。', stroke, 32, { arrowSize: 22, lineWidth: 3 });
  const { frame, node: styledNode } = await createDiagramStyle(f);
  const node = (x, y, width, height, title, detail = [], options = {}) =>
    styledNode(x, y, width, height, title, detail, { ...options, lineHeight: 52 });
  node(80, 20, 640, 120, 'Web 页面', 'React / Next.js');
  node(880, 20, 640, 120, '微信通道', 'pi-weixinbot / HTTP JSON');
  frame(80, 210, 1440, 210, 'interface');
  f.text(800, 252, 'Next.js Route Handlers · 银行 API', { weight: 600 });
  node(110, 280, 420, 110, '页面业务 API', '业务查询 / 页面办理', { fill: '#FFFFFF' });
  node(570, 280, 420, 110, '对话 API · /api/chat', 'JSON / SSE', { fill: '#FFFFFF' });
  node(1030, 280, 460, 110, '操作与任务 API', '确认 / 验证 / 任务控制', { fill: '#FFFFFF' });
  f.path('M400 140 V210', { both: true });
  f.path('M1200 140 V210', { both: true });

  node(80, 500, 360, 150, '页面业务服务', '独立参数与授权校验');
  f.path('M320 390 V500');
  frame(500, 500, 940, 360, 'intelligence');
  f.text(530, 545, '持久化 Agent 运行时', { anchor: 'start', weight: 600 });
  node(530, 570, 410, 110, 'Pi Agent Core', '上下文管理与压缩', { role: 'intelligence', fill: '#FFFFFF' });
  node(1000, 570, 410, 110, '模型适配器', '在线 LLM / Mock', { role: 'intelligence', fill: '#FFFFFF' });
  node(530, 730, 410, 110, '运行日志与检查点', '事件 / 租约 / 恢复', { role: 'intelligence', fill: '#FFFFFF' });
  node(1000, 730, 410, 110, '工具注册与参数校验', 'Tool Registry / Zod', { role: 'intelligence', fill: '#FFFFFF' });
  f.path('M780 390 V500', { both: true });
  f.path('M940 625 H1000', { both: true });
  f.path('M735 680 V705 H1205 V730');

  node(150, 720, 290, 130, '运行恢复进程', 'agent:worker', { role: 'neutral' });
  f.path('M440 785 H530');
  node(150, 970, 290, 170, '定时任务调度', ['scheduler:tick', '提醒 / 到期付款'], { role: 'neutral' });

  frame(500, 930, 1020, 220, 'authorization');
  f.text(530, 975, '任务编排与授权', { anchor: 'start', weight: 600 });
  node(530, 1010, 410, 120, 'DAG 编译与执行', '拓扑 / 条件 / 挂起恢复', { role: 'intelligence', fill: '#FFFFFF' });
  node(1000, 1010, 410, 120, '安全网关', '权限 / 风险 / 确认 / MFA', { role: 'authorization', fill: '#FFFFFF' });
  f.path('M1205 840 V900 H850 V1010');
  f.path('M1310 840 V1010');
  f.path('M940 1070 H1000');
  f.path('M440 1055 H530');
  f.text(485, 1030, '付款');
  f.path('M1470 390 V930');

  frame(80, 1220, 1440, 190, 'banking');
  f.text(800, 1265, '命令执行器 · 事务 / 幂等回执 / 必需审计', { weight: 600 });
  f.text(800, 1310, '模拟银行 SDK', { weight: 600 });
  ['账户与转账', '理财与卡片', '账单与预算', '订阅与定时'].forEach((name, index) =>
    node(110 + index * 350, 1330, 330, 60, name, [], { role: 'banking', fill: '#FFFFFF' }));
  f.path('M1205 1130 V1220');
  f.path('M110 650 V1220');

  node(80, 1460, 1440, 90, '共享数据访问 · Repositories / Unit of Work / Prisma', [], { role: 'neutral' });
  f.path('M800 1410 V1460');
  node(80, 1610, 1440, 120, 'SQLite · WAL', '业务与回执 · 会话与运行 · 任务与授权 · 审计事件', { role: 'banking' });
  f.path('M800 1550 V1610');
  await f.save();
}

// Presentation architecture: nested functional groups on a transparent canvas.
{
  const f = new Figure('system-architecture-ppt.svg', 1920, 960, '系统总体架构（PPT 版）',
    '透明画布上的插画分组架构。文字统一字号和黑色，模块标题加粗，说明与连接标注采用常规字重。模块颜色区分职责，粗灰箭头表示请求与执行，蓝色虚线表示结果与状态经服务接口返回Web或微信。页面办理独立校验，智能体经过安全网关，两者共用银行业务工具库。', stroke, 32);
  const { frame, label, illustration, bigArrow, response } = await createDiagramStyle(f);

  for (const [y, text] of [[106, '渠道接入'], [252, '服务入口'], [475, '编排与授权'], [731, '银行业务'], [900, '持久化']]) {
    label(30, y, text, { anchor: 'start' });
  }

  frame(250, 20, 1410, 140, 'interface');
  frame(280, 40, 600, 100, 'interface', '#FFFFFF', 12);
  illustration('web', 320, 50, 88);
  label(618, 100, 'Web 页面');
  frame(1010, 40, 620, 100, 'interface', '#FFFFFF', 12);
  illustration('wechat', 1050, 50, 88);
  label(1370, 100, '微信接入');

  frame(250, 188, 1410, 100, 'interface');
  illustration('api', 470, 197, 80);
  label(795, 251, '银行服务接口');
  label(1290, 250, '接收请求 · 返回结果', { weight: 400 });

  frame(250, 316, 920, 288, 'intelligence');
  label(710, 359, '智能体办理');
  frame(280, 380, 520, 204, 'intelligence', '#FFFFFF', 12);
  illustration('agent', 320, 396, 92);
  label(620, 453, '银行智能体');
  frame(306, 502, 210, 56, 'intelligence');
  label(411, 539, '模型调用', { weight: 400 });
  frame(540, 502, 230, 56, 'intelligence');
  label(655, 539, '多步任务编排', { weight: 400 });
  frame(890, 380, 250, 204, 'authorization');
  illustration('shield', 967, 388, 96);
  label(1015, 512, '安全网关');
  label(1015, 564, '确认 / 验证', { weight: 400 });

  frame(1230, 316, 430, 288, 'interface');
  label(1445, 359, '页面办理');
  frame(1260, 380, 370, 204, 'interface', '#FFFFFF', 12);
  illustration('page', 1284, 415, 86);
  label(1490, 463, '页面业务服务');
  label(1490, 514, '独立授权校验', { weight: 400 });

  frame(250, 632, 1410, 178, 'banking');
  illustration('bank', 281, 673, 115);
  label(1030, 672, '银行业务工具库');
  [['转账汇款', 'transfer'], ['理财管理', 'investment'], ['银行卡管理', 'card'], ['记账预算', 'budget']].forEach(([title, name], i) => {
    const x = 430 + i * 300;
    frame(x, 696, 270, 96, 'banking', '#DCEEE8', 10);
    illustration(name, x + 20, 719, 48);
    label(x + 170, 754, title, { weight: 500 });
  });

  frame(250, 838, 1410, 100, 'banking');
  illustration('db', 278, 857, 62);
  label(510, 900, '业务数据存储');
  ['业务与流水', '授权与审计', '运行与任务'].forEach((title, i) => {
    const x = 720 + i * 300;
    frame(x, 856, 280, 64, 'banking', '#FFFFFF', 7);
    label(x + 140, 900, title, { weight: 400 });
  });

  bigArrow(580, 160, 188);
  bigArrow(1260, 160, 188);
  bigArrow(710, 288, 316);
  bigArrow(1445, 288, 316);
  bigArrow(482, 800, 890, true);
  bigArrow(1015, 604, 632);
  bigArrow(1445, 604, 632);
  bigArrow(955, 810, 838);

  response('M1660 714 H1720 Q1740 714 1740 694 V258 Q1740 238 1720 238 H1660');
  response('M780 188 V140');
  response('M1510 188 V140');
  label(1760, 452, '结果回传', { anchor: 'start', weight: 400 });
  await f.save();
}

// Sequence: the human user and the delivery channel have separate lifelines.
{
  const f = new Figure('transfer-sequence.svg', 1920, 1490, '转账请求执行时序',
    '用户通过Web或微信提出转账，并通过同一渠道核对原操作、确认或验证。银行智能体提出操作，安全网关保存原操作、认领执行权并复核风险。需要追加验证与满足授权条件为互斥分支。业务结果经渠道展示给用户。实线为请求，蓝色虚线为返回。', stroke, 32);
  const { frame, illustration } = await createDiagramStyle(f);
  const xs = [160, 480, 800, 1120, 1440, 1760];
  const actors = [
    ['用户', 'interface', 'user'],
    ['Web / 微信', 'interface', null],
    ['银行智能体', 'intelligence', 'agent'],
    ['安全网关', 'authorization', 'shield'],
    ['银行业务工具库', 'banking', 'bank'],
    ['数据库', 'banking', 'db'],
  ];
  f.parts.push('<defs><marker id="sequence-request" viewBox="0 0 16 16" refX="15" refY="8" markerWidth="16" markerHeight="16" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L15 8 L1 15 L4 8Z" fill="#64748B"/></marker><marker id="sequence-return" viewBox="0 0 16 16" refX="15" refY="8" markerWidth="16" markerHeight="16" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L15 8 L1 15 L4 8Z" fill="#4D8CA9"/></marker></defs>');
  actors.forEach(([title, role, icon], i) => {
    frame(xs[i] - 130, 20, 260, 140, role);
    if (icon) {
      illustration(icon, xs[i] - 36, 28, 72);
    } else {
      illustration('web', xs[i] - 62, 34, 54);
      illustration('wechat', xs[i] + 10, 34, 54);
    }
    f.text(xs[i], 141, title, { weight: 600 });
    f.path(`M${xs[i]} 160 V1460`, { arrow: false, dashed: true, opacity: 0.32, maskText: true });
  });

  function wire(path, returned = false) {
    f.parts.push(`<path class="wire" d="${path}" style="stroke:${returned ? '#4D8CA9' : '#64748B'};stroke-width:3"${returned ? ' stroke-dasharray="8 7"' : ''} marker-end="url(#sequence-${returned ? 'return' : 'request'})"/>`);
  }

  function message(y, from, to, text, returned = false) {
    wire(`M${xs[from]} ${y} H${xs[to]}`, returned);
    f.text((xs[from] + xs[to]) / 2, y - 16, text);
  }
  message(220, 0, 1, '提出转账需求');
  message(284, 1, 2, '提交消息与请求标识');
  message(348, 2, 3, '解析对象并提出操作');
  message(412, 3, 5, '保存原操作与风险');
  message(476, 3, 1, '返回确认 / 验证入口', true);
  message(540, 1, 0, '展示操作详情', true);
  message(604, 0, 1, '核对并确认 / 验证');
  message(668, 1, 3, '提交原操作决定');
  message(732, 3, 5, '认领执行权');
  wire('M1120 766 H1190 V812 H1120');
  f.text(1220, 798, '复核风险', { anchor: 'start' });

  frame(30, 850, 1860, 610, 'neutral', 'none', 14);
  frame(50, 862, 300, 56, 'authorization', null, 10);
  f.text(200, 902, '需要追加验证', { weight: 600 });
  message(938, 3, 1, '等待验证，不扣款', true);
  message(994, 1, 0, '提示继续验证', true);
  f.path('M30 1034 H1890', { arrow: false, dashed: true });
  frame(50, 1050, 300, 56, 'banking', null, 10);
  f.text(200, 1090, '授权条件满足', { weight: 600 });
  message(1122, 3, 4, '提交原命令');
  message(1182, 4, 5, '复核并事务提交');
  message(1242, 5, 4, '返回提交结果', true);
  message(1302, 4, 3, '返回执行回执', true);
  message(1362, 3, 1, '返回业务结果与状态', true);
  message(1422, 1, 0, '展示结果与状态', true);
  await f.save();
}

// Conditional workflow: only the example's dependencies and confirmation gate.
{
  const f = new Figure('dag-workflow.svg', 960, 1060, '条件任务 DAG 与确认门控',
    '查询本月消费并比较用户指定阈值。条件满足时创建原操作，等待用户确认后执行并保存结果；条件不满足时跳过调整。两条路径均结束本条件分支。');
  const { node, colors } = await createDiagramStyle(f);
  node(60, 20, 400, 90, '查询本月消费', '返回结构化结果');
  f.path('M260 110 V155');
  f.diamond(260, 255, 195, 100, ['消费金额是否超过', '用户指定阈值？'], colors.intelligence);
  f.path('M260 355 V420');
  f.text(285, 387, '是', { anchor: 'start' });
  f.path('M455 255 H770 V420');
  f.text(510, 238, '否');
  node(60, 420, 400, 100, '提出限额调整', '保存原操作，尚未执行', { role: 'intelligence' });
  node(640, 420, 260, 100, '跳过调整', '不创建调整授权', { role: 'neutral' });
  f.path('M260 520 V600');
  node(60, 600, 400, 100, '等待用户确认', '挂起当前节点', { role: 'authorization' });
  f.path('M260 700 V780');
  f.text(285, 747, '确认通过', { anchor: 'start' });
  node(60, 780, 400, 100, '执行并保存结果', '关联原操作与节点', { role: 'banking' });
  f.path('M260 880 V960');
  f.path('M770 520 V1000 H460');
  node(60, 960, 400, 80, '结束本条件分支', [], { role: 'neutral' });
  await f.save();
}

// State chart: local orthogonal transitions keep the main execution path short.
{
  const f = new Figure('action-state.svg', 1200, 740, '原操作授权与执行状态',
    '待确认可升级为待验证。确认或验证通过后认领执行权并复核业务。验证第1、2次错误保持待验证，第3次错误锁定。取消与锁定为原操作终态；执行结果区分已执行、确定未提交的失败与结果未知的待核对。');
  const { node } = await createDiagramStyle(f);
  node(80, 40, 300, 100, '待确认', [], { role: 'authorization', icon: 'shield' });
  node(500, 40, 300, 100, '已授权 · 待执行', '认领执行权并复核', { role: 'intelligence' });
  node(900, 40, 260, 100, '已执行', '事务与回执已保存', { role: 'banking' });
  node(80, 300, 300, 100, '待验证', '绑定原操作与挑战', { role: 'authorization' });
  node(900, 300, 260, 100, '已失败', '确认业务未提交', { role: 'neutral' });
  node(80, 600, 300, 100, '已取消', '原操作终态', { role: 'neutral' });
  node(900, 600, 260, 100, '待核对', '无法确定是否提交', { role: 'authorization' });
  node(500, 600, 300, 100, '已锁定', '原操作终态', { role: 'neutral' });

  f.path('M380 90 H500');
  f.text(440, 72, '确认通过');
  f.path('M230 140 V300');
  f.text(250, 230, '风险升级', { anchor: 'start' });
  f.path('M380 340 H440 V120 H500');
  f.text(460, 235, '验证通过', { anchor: 'start' });
  f.path('M80 90 H24 V650 H80');
  f.text(34, 265, '取消', { anchor: 'start' });
  f.path('M230 400 V600');
  f.text(250, 535, '取消', { anchor: 'start' });
  f.path('M80 350 H52 V450 H130 V400');
  f.text(48, 490, '第 1、2 次', { anchor: 'start' });
  f.text(48, 530, '验证错误', { anchor: 'start' });
  f.path('M380 375 H650 V600');
  f.text(675, 510, '第 3 次错误', { anchor: 'start' });
  f.path('M800 90 H850', { arrow: false });
  f.path('M850 90 H900');
  f.path('M850 90 V350 H900');
  f.path('M850 350 V650 H900');
  await f.save();
}

console.log(`Saved to ${fileURLToPath(destination)}`);
