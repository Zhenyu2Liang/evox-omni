'use client';

import { Badge, Card } from '../../ui';

export interface ErrorCardProps {
  message: string;
  code?: string;
  detail?: string;
  className?: string;
}

export function ErrorCard({ message, code, detail, className }: ErrorCardProps) {
  return (
    <Card className={className}>
      <div className="flex items-start gap-3">
        <Badge tone="danger">异常</Badge>
        <div className="flex flex-col gap-1">
          <p className="font-medium text-banking-deep">{message}</p>
          {code ? <span className="text-xs text-banking-navy/60">错误码：{code}</span> : null}
          {detail ? <span className="text-sm text-banking-navy/70">{detail}</span> : null}
        </div>
      </div>
    </Card>
  );
}
