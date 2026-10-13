'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ManualResolution, ManualReviewInbox, ManualReviewRecord, ManualReviewTarget } from '@/lib/contracts/manual-review';
import { Badge, Button, Card } from '@/components/ui';

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  const envelope = await response.json();
  if (!response.ok || !envelope.ok) throw new Error(envelope.error?.message ?? '请求失败，请稍后重试。');
  return envelope.data as T;
}

function ReviewForm({ title, label, onSubmit, busy, mayRetry, mayResume, mayStop = true }: {
  title: string; label: string; busy: boolean; mayRetry?: boolean; mayResume?: boolean; mayStop?: boolean;
  onSubmit: (text: string, resolution: ManualResolution) => Promise<void>;
}) {
  const [text, setText] = useState('');
  return <div className="space-y-3">
    <label className="block text-sm font-medium">{label}
      <textarea aria-label={`${label}：${title}`} value={text} onChange={(e) => setText(e.target.value)}
        maxLength={label === '转人工原因' ? 1000 : 2000} rows={3}
        className="mt-2 w-full rounded-xl border border-gray-300 p-3 font-normal" placeholder="至少填写 5 个字" />
    </label>
    <div className="flex flex-wrap gap-2">
      <Button loading={busy} disabled={!mayStop || text.trim().length < 5} onClick={() => void onSubmit(text, 'stop')}>
        {label === '转人工原因' ? '转人工处理' : '记录并结束自动处理'}
      </Button>
      {mayRetry && <Button variant="secondary" disabled={busy || text.trim().length < 5}
        onClick={() => void onSubmit(text, 'retry')}>记录并继续任务</Button>}
      {mayResume && <Button variant="secondary" disabled={busy || text.trim().length < 5}
        onClick={() => void onSubmit(text, 'resume')}>{'\u8bb0\u5f55\u5e76\u6062\u590d\u539f\u4efb\u52a1'}</Button>}
    </div>
  </div>;
}

export default function ManualPage() {
  const [inbox, setInbox] = useState<ManualReviewInbox>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setInbox(await request<ManualReviewInbox>('/api/manual-reviews')), []);
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, [load]);

  async function act(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : '处理失败。'); }
    finally { await load().catch(() => {}); setBusy(false); }
  }

  async function continueTask(review: ManualReviewRecord) {
    if (!review.taskId) return;
    if (review.resolution === 'resume' && review.workflowStatus === 'waiting_confirmation') {
      setNotice('\u5df2\u91ca\u653e\u4eba\u5de5\u63a7\u5236\uff0c\u8bf7\u56de\u5230 AI \u52a9\u624b\u5904\u7406\u539f\u5f85\u786e\u8ba4\u64cd\u4f5c\u3002');
      return;
    }
    const plan = await request<{ status: string }>(`/api/tasks/${review.taskId}`, { action: review.resolution === 'resume' ? 'resume' : 'retry' });
    setNotice(plan.status === 'waiting_confirmation' ? '任务已重新发起，请到 AI 助手确认操作或完成 MFA。'
      : plan.status === 'success' ? '任务已完成。' : '任务状态已更新，请到 AI 助手查看。');
  }

  function open(target: ManualReviewTarget, reason: string) {
    return act(async () => {
      await request('/api/manual-reviews', { taskId: target.taskId, actionId: target.actionId, reason });
      setNotice('\u5df2\u8bf7\u6c42\u4eba\u5de5\u63a7\u5236\uff0c\u5f53\u524d\u64cd\u4f5c\u5230\u8fbe\u5b89\u5168\u68c0\u67e5\u70b9\u540e\u505c\u6b62\u81ea\u52a8\u7ee7\u7eed\u3002');
    });
  }

  function resolve(review: ManualReviewRecord, notes: string, resolution: ManualResolution) {
    return act(async () => {
      const saved = await request<ManualReviewRecord>(`/api/manual-reviews/${review.id}`, { resolution, notes });
      if (resolution === 'retry' || resolution === 'resume') await continueTask(saved);
      else setNotice('已记录处理结论并结束自动处理；已入账交易保留，结果不明的操作仍需核对。');
    });
  }

  return <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
    <h1 className="text-2xl font-semibold text-banking-deep">人工处理</h1>
    <p className="text-sm text-gray-600">Demo 人工处理席位：{inbox?.operatorName ?? '正在验证会话' }。
      填写核对说明后可结束自动处理，或对明确失败的任务重新发起确认。结果不明的交易不能重跑，已入账交易不会回滚。</p>
    <div className="flex gap-4 text-sm"><Link href="/agent" className="text-banking-accent underline">返回 AI 助手</Link>
      <Link href="/audit" className="text-banking-accent underline">查看审计记录</Link>
      <Button variant="ghost" disabled={busy} onClick={() => void act(async () => { await load(); })}>刷新</Button></div>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded-xl bg-blue-50 p-3 text-banking-accent">{notice}</p>}
    {!inbox && !error && <p>加载中…</p>}
    {inbox && inbox.candidates.length === 0 && inbox.reviews.length === 0 && <p>当前会话没有需要人工处理的异常任务。</p>}
    {inbox?.reviews.map((review) => <section key={review.id} data-review-id={review.id}>
      <Card title={review.title} description={`处理人：${review.operatorName} · ${new Date(review.createdAt).toLocaleString('zh-CN')}`}>
        <div className="space-y-3">
          <Badge tone={review.status === 'open' ? 'warn' : 'neutral'}>{review.status === 'open' ? '人工处理中' : '已记录处理结论'}</Badge>
          <p className="text-sm">转人工原因：{review.reason}</p>
          {review.handoffStatus === 'human_review_requested' && <p role="status" className="text-sm text-banking-navy">
            {'\u7b49\u5f85\u5f53\u524d\u64cd\u4f5c\u5230\u8fbe\u5b89\u5168\u68c0\u67e5\u70b9\uff0c\u8bf7\u5237\u65b0\u540e\u518d\u8bb0\u5f55\u5904\u7406\u7ed3\u8bba\u3002'}
          </p>}
          {review.status === 'open' ? <ReviewForm title={review.title} label="核对说明" busy={busy} mayRetry={review.mayRetry}
            mayResume={review.mayResume} mayStop={review.mayStop}
            onSubmit={(text, resolution) => resolve(review, text, resolution)} /> : <>
            <p className="text-sm">核对说明：{review.notes}</p>
            <p className="text-xs text-gray-500">处理时间：{review.resolvedAt && new Date(review.resolvedAt).toLocaleString('zh-CN')}</p>
            <p className="text-sm">处理结论：{review.resolution === 'retry' ? '允许重新发起确认；继续执行仍受原权限约束'
              : review.resolution === 'resume' ? '\u5df2\u91ca\u653e\u4eba\u5de5\u63a7\u5236\uff1b\u7ee7\u7eed\u6267\u884c\u4ecd\u9700\u539f\u6743\u9650\u786e\u8ba4\u548c\u9a8c\u8bc1' : '结束自动处理；保留真实交易结果'}</p>
            {review.resolution === 'retry' && review.mayRetry && <Button disabled={busy} variant="secondary"
              onClick={() => void act(() => continueTask(review))}>继续任务（重新确认）</Button>}
            {review.resolution === 'resume' && review.mayResume && <Button disabled={busy} variant="secondary"
              onClick={() => void act(() => continueTask(review))}>{'\u7ee7\u7eed\u539f\u4efb\u52a1'}</Button>}
          </>}
        </div>
      </Card>
    </section>)}
    {inbox?.candidates.map((target) => <section key={target.taskId ?? target.actionId}>
      <Card title={target.title} description={target.error}>
        <ReviewForm title={target.title} label="转人工原因" busy={busy} onSubmit={(text) => open(target, text)} />
      </Card>
    </section>)}
  </main>;
}
