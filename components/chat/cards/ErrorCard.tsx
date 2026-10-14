'use client';

import { Badge, Card } from '../../ui';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { publicToolError } from '@/lib/tool-feedback';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import { sanitizeToolArguments } from '@/lib/tool-diagnostics';

export interface ErrorCardProps {
  message: string;
  code?: string;
  detail?: string;
  className?: string;
}

export function ErrorCard({ message, code, detail, className }: ErrorCardProps) {
  const { t } = useI18n();
  const { enabled: developerMode } = useDeveloperMode();
  return (
    <Card className={className}>
      <div className="flex items-start gap-3">
        <Badge tone="danger">{t('cards.error')}</Badge>
        <div className="flex flex-col gap-1">
          <p className="font-medium text-banking-deep">{publicToolError(message, t, 'chat.error.toolFailed', code)}</p>
          {developerMode && <details data-error-diagnostics="true" className="mt-2 min-w-0 text-xs text-banking-navy">
            <summary>{t('chat.diagnostics.detail')}</summary>
            <pre className="mt-2 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(sanitizeToolArguments({ message, code, detail }), null, 2)}</pre>
          </details>}
        </div>
      </div>
    </Card>
  );
}
