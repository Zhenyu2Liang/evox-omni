import type { createDatabaseClient } from '../../lib/db/database';
import type { BankingChannel } from '../../channels/weixin/banking-client';
import type { WeixinState } from '../../channels/weixin/state';
import { TOOL_NAMES } from '../../lib/contracts/tool-catalog';

interface Context {
  db: ReturnType<typeof createDatabaseClient>; bank: BankingChannel; state: WeixinState; replies: string[];
  receive(text: string): Promise<number>; check(name: string, run: () => Promise<void>): Promise<void>;
}
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };

/** 微信协议服务器与真实银行/模型之间的完整业务矩阵，不向真实联系人发测试消息。 */
export async function runWeixinCapabilities(ctx: Context): Promise<{ observed: string[]; notObserved: string[] }> {
  const { db, bank, state, receive, check } = ctx;
  async function authorize(prompt: string, tool: string) {
    const known = new Set((await db.pendingAction.findMany({ select: { id: true } })).map(row => row.id));
    await receive(prompt);
    let action = (await db.pendingAction.findMany({ where: { toolName: tool }, orderBy: { createdAt: 'desc' } })).find(row => !known.has(row.id));
    // 最多一次明确补充，必须依旧由模型调用工具和服务端创建授权。
    if (!action) {
      await receive('请按刚才的完整信息继续发起该业务，我会核对详情并通过微信确认命令处理。');
      action = (await db.pendingAction.findMany({ where: { toolName: tool }, orderBy: { createdAt: 'desc' } })).find(row => !known.has(row.id));
    }
    assert(action, `${tool}: no actual gated action`);
    assert(state.offered[action.id], `${tool}: action details missing in channel`);
    assert(['pending', 'awaiting_mfa'].includes(action.status), `${tool}: executed without explicit command`);
    await receive(`/确认 ${action.id}`);
    const row = await db.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
    if (row.status === 'awaiting_mfa') await receive(`/验证 ${action.id} 123456`);
    assert((await db.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status === 'executed', `${tool}: did not execute after authorization`);
    return action.id;
  }
  const queries = [
    ['查询最近5笔交易明细，包含商户、时间和金额。', 'get_transactions', '交易记录'],
    ['分析2026年9月的消费分类、总额和环比。', 'analyze_spending', '消费分析'],
    ['检查2026年9月账单中的异常交易。', 'detect_anomaly', '可疑交易检查'],
    ['查找联系人李华，显示手机号和银行。', 'search_contact', '135****0005'],
    ['查询我所有卡片的状态和限额，包括虚拟卡的结算账户与可支付金额。', 'get_cards', '卡片'],
    ['查询可购买的全部理财产品，显示年化收益率、风险和起购金额。', 'list_investments', '理财产品'],
    ['对比稳健理财A与稳健理财B的期限、收益率和风险。', 'compare_investments', '理财产品'],
    ['查询我的全部理财持仓、本金、市值和收益。', 'get_investment_holdings', '理财持仓'],
    ['查询资产总览，包括总资产、活期余额、信用卡可用授信和当月消费。', 'get_dashboard_summary', '资产总览'],
    ['查询已保存的全部定时任务及到期时间。', 'list_scheduled_tasks', '定时任务'],
  ];
  for (const [prompt, tool, expected] of queries) {
    await check(`微信查询：${tool}`, async () => {
      const before = await db.toolInvocation.count({ where: { toolName: tool } }); const start = ctx.replies.length;
      await receive(prompt);
      assert(await db.toolInvocation.count({ where: { toolName: tool } }) > before, `${tool}: model did not use capability`);
      assert(ctx.replies.slice(start).join('\n').includes(expected), `${tool}: structured result missing`);
    });
  }
  await check('微信订阅查询确认、续费提醒与取消', async () => {
    await authorize('查询我的全部订阅和代扣详情，需要确认时请发起操作。', 'list_subscriptions');
    await authorize('开启Spotify订阅的续费提醒。', 'set_subscription_reminder');
    assert((await db.subscription.findUniqueOrThrow({ where: { id: 'sub_spotify' } })).remind, 'Reminder not enabled');
    await authorize('取消Netflix订阅，不再续费。', 'cancel_subscription');
    assert((await db.subscription.findUniqueOrThrow({ where: { id: 'sub_netflix' } })).status === 'CANCELLED', 'Subscription not cancelled');
  });
  await check('微信分类消费限额与可逆锁卡', async () => {
    const credit = await db.card.findUniqueOrThrow({ where: { id: 'card_credit' } });
    await authorize('将尾号8821借记卡的娱乐分类消费限额设置为1500.25元，不是调整授信额度。', 'set_card_limit');
    assert((await db.cardLimit.findFirstOrThrow({ where: { cardId: 'card_debit', category: '娱乐' } })).amountMinor === 150025n, 'Category limit incorrect');
    await authorize('临时冻结尾号8821的借记卡，之后还要解冻，不是正式挂失。', 'freeze_card');
    assert((await db.card.findUniqueOrThrow({ where: { id: 'card_debit' } })).status === 'FROZEN', 'Card not frozen');
    await authorize('解冻刚才临时冻结的尾号8821借记卡。', 'unfreeze_card');
    assert((await db.card.findUniqueOrThrow({ where: { id: 'card_debit' } })).status === 'ACTIVE', 'Card not unfrozen');
    assert((await db.card.findUniqueOrThrow({ where: { id: 'card_credit' } })).creditLimitMinor === credit.creditLimitMinor, 'Changed credit line');
  });
  await check('微信申购合并持仓与部分赎回', async () => {
    const before = await db.investmentHolding.findUniqueOrThrow({ where: { id: 'holding_wenjiana' } });
    await authorize('从活期账户申购1000元稳健理财A。', 'subscribe_investment');
    assert((await db.investmentHolding.findUniqueOrThrow({ where: { id: before.id } })).principalAmountMinor === before.principalAmountMinor + 100000n, 'Purchase not aggregated');
    const cashBefore = (await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
    await authorize('从稳健理财A持仓中部分赎回1000元本金，保留剩余持仓。', 'redeem_investment');
    const holding = await db.investmentHolding.findUniqueOrThrow({ where: { id: before.id } });
    assert(holding.principalAmountMinor === before.principalAmountMinor && holding.status === 'HOLDING', 'Partial redemption closed or mis-sized holding');
    assert((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor > cashBefore, 'Redemption did not credit checking');
  });
  await check('微信虚拟卡申请、消费与补办额度连续', async () => {
    const known = new Set((await db.card.findMany()).map(row => row.id));
    await authorize('请新开一张月消费限额100元的虚拟卡，绑定我的活期账户。', 'apply_virtual_card');
    const card = (await db.card.findMany()).find(row => !known.has(row.id)); assert(card?.type === 'VIRTUAL', 'Virtual card missing');
    const tail = card.numberMasked.slice(-4);
    await authorize(`用尾号${tail}的虚拟卡消费12.34元，商户为微信功能测试，分类为购物。`, 'consume_virtual_card');
    assert((await db.cardConsumption.findMany({ where: { cardId: card.id } })).length === 1, 'Consumption missing or duplicated');
    await authorize(`尾号${tail}虚拟卡信息泄露，请正式挂失，我接受不可撤销。`, 'report_lost_card');
    await authorize(`请为刚挂失的尾号${tail}虚拟卡补办新卡。`, 'replace_card');
    const source = await db.card.findUniqueOrThrow({ where: { id: card.id } }); assert(source.replacedByCardId, 'No replacement link');
    const replacement = await db.card.findUniqueOrThrow({ where: { id: source.replacedByCardId } });
    assert(replacement.linkedAccountId === 'acct_checking' && replacement.monthlyLimitMinor === 10000n, 'Replacement binding/limit lost');
    assert(ctx.replies.slice(-3).join('\n').includes('¥87.66'), 'IM did not show remaining family allowance');
  });
  await check('微信预算记录、定时创建和到期检查', async () => {
    const before = (await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
    await receive('登记一条123.45元的预算记录，名称为微信功能预算，用于生日礼物，只记账不转账。');
    assert(await db.budget.count({ where: { amountMinor: 12345n } }) === 1, 'Budget not created');
    assert((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor === before, 'Budget moved money');
    await authorize('在2099年12月20日上午9点提醒我检查账单，任务名称为微信到期检查，仅提醒，不付款。', 'create_scheduled_task');
    const reminder = await db.scheduledTask.findFirstOrThrow({ where: { name: '微信到期检查' } });
    // 仅在本次新建测试库把提醒置为到期；HTTP 入口依旧使用真实时钟，不接受调用方 now。
    await db.scheduledTask.update({ where: { id: reminder.id }, data: { runAt: new Date(Date.now() - 1000) } });
    await receive('/定时任务'); await receive('/检查到期');
    assert(await db.scheduledNotification.count({ where: { scheduledTaskId: reminder.id } }) === 1, 'Due notification not delivered');
    const count = await db.scheduledNotification.count(); await receive('/检查到期');
    assert(await db.scheduledNotification.count() === count, 'Repeated tick duplicated notification');
  });
  await check('微信多步任务暂停、继续、取消与门控恢复', async () => {
    // 先取消到期检查产生的其他待确认操作，避免测试计划与旧入口混淆；没有确认任何付款。
    await receive('/待办'); for (const action of await bank.actions()) if (['pending', 'awaiting_mfa'].includes(action.status)) await receive(`/取消 ${action.id}`);
    const known = new Set((await bank.plans()).map(row => row.id));
    await receive('请创建有序的多步任务：先查询2026年9月消费，再将尾号8821借记卡的购物分类消费限额设为900.50元，最后登记219.87元预算。每一步成功后再做下一步。');
    const plan = (await bank.plans()).find(row => !known.has(row.id)); assert(plan, 'No actual submitted workflow');
    await receive(`/暂停 ${plan.id}`); assert((await bank.plan(plan.id)).status === 'paused', 'Plan did not pause');
    await receive(`/继续 ${plan.id}`); await receive(`/任务 ${plan.id}`);
    const pending = (await bank.actions()).find(row => row.toolName === 'set_card_limit');
    assert(pending && state.offered[pending.id], 'Resumed workflow gate missing in IM');
    await receive(`/取消任务 ${plan.id}`);
    assert((await bank.plan(plan.id)).status === 'cancelled', 'Plan did not cancel');
    assert((await db.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status === 'cancelled', 'Cancelled plan left executable authorization');
    const replyStart = ctx.replies.length;
    await receive('刚才的多步任务现在是什么状态？是否已经取消？还需要我确认执行吗？请按当前真实状态回答。');
    const statusReply = ctx.replies.slice(replyStart).join('\n');
    assert(statusReply.includes('已取消') || statusReply.includes('已经取消'), 'Conversation reused the obsolete waiting workflow state');
    assert((await bank.plan(plan.id)).status === 'cancelled', 'Status query resumed a cancelled plan');
  });
  await check('微信完整对话归档搜索', async () => {
    const before = await db.toolInvocation.count({ where: { toolName: 'search_conversation_history' } });
    const replyStart = ctx.replies.length;
    await receive('请使用完整对话归档搜索工具，检索我最早查询活期账户余额的用户原话。请实际搜索归档，不要仅根据当前上下文回答。');
    assert(await db.toolInvocation.count({ where: { toolName: 'search_conversation_history' } }) > before, 'Archive search capability not used');
    assert(ctx.replies.slice(replyStart).join('\n').includes('活期'), 'Archived original wording missing');
  });
  const observed = [...new Set((await db.toolInvocation.findMany({ select: { toolName: true } })).map(row => row.toolName))].filter(name => TOOL_NAMES.includes(name as typeof TOOL_NAMES[number]));
  return { observed, notObserved: TOOL_NAMES.filter(name => !observed.includes(name)) };
}
