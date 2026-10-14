import { RunHistory } from '@/components/runtime/RunHistory';
import { getServerDeveloperMode } from '@/lib/developer-mode/server';
import { DeveloperModeRequired } from '../_components/DeveloperTools';

export default async function RunsPage() {
  const enabled = await getServerDeveloperMode();
  return <main className="mx-auto w-full min-w-0 max-w-6xl p-4 sm:p-6 lg:p-8">{enabled ? <RunHistory /> : <DeveloperModeRequired />}</main>;
}
