import type { AssistantMessage } from '@earendil-works/pi-ai';
import { knownNameInText } from './names';
import { plain, toolCall } from './replies';

const subscriptionIds: Record<string, string> = {
  Netflix: 'sub_netflix', Spotify: 'sub_spotify', iCloud: 'sub_icloud',
  视频会员: 'sub_video', 健身会员: 'sub_fitness', 云盘会员: 'sub_cloud',
};

export function classifySubscriptionAction(text: string): AssistantMessage | undefined {
  if (!/(取消|退订)/.test(text)) return undefined;
  const known = knownNameInText(text, subscriptionIds);
  if (!/(订阅|会员|续费)/.test(text) && !known) return undefined;
  const candidate = known ??
    text.match(/取消\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,20}?)\s*订阅/)?.[1]?.trim() ??
    text.match(/取消\s*订阅\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,20})/)?.[1]?.trim();
  const name = known || (candidate && !/的|我的|这个|那个|哪个|哪些|所有|全部/.test(candidate) ? candidate : undefined);
  if (!name) return plain('请问要取消哪个订阅？例如“取消Netflix订阅”。');
  return toolCall('cancel_subscription', { subscriptionId: subscriptionIds[name] ?? name });
}
