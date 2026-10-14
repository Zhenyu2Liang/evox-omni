import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CardRenderer } from '@/components/chat/cards/CardRenderer';
import type { TaskPlan } from '@/lib/contracts/task';

vi.mock('@/components/chat/cards/PlanCard', () => ({
  PlanCard: (props: { onControl?: (action: 'pause') => void }) => {
    props.onControl?.('pause');
    return null;
  },
}));

describe('historical plan controls', () => {
  it('passes the rendered plan identity rather than allowing the newest global plan to receive its action', () => {
    const plan: TaskPlan = { id: 'historical-plan', sessionId: 'session', goal: 'Historical plan', status: 'paused',
      nodes: [], results: [], createdAt: 1, updatedAt: 2 };
    const control = vi.fn();
    renderToStaticMarkup(createElement(CardRenderer, { card: { type: 'plan', plan }, action: { onTaskControl: control } }));
    expect(control).toHaveBeenCalledTimes(1);
    expect(control).toHaveBeenCalledWith('pause', 'historical-plan');
  });
});
