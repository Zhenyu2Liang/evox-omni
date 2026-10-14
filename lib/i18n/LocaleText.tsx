'use client';

import { useI18n } from './LocaleProvider';
import type { MessageKey, MessageParams } from './shared';

/** A translated leaf keeps server-rendered parents and their render callbacks server-safe. */
export function LocaleText({ messageKey, params }: { messageKey: MessageKey; params?: MessageParams }) {
  const { t } = useI18n();
  return <>{t(messageKey, params)}</>;
}
