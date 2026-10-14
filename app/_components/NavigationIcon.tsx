import type { NavigationIconName } from './navigation';

const ICON_PATHS: Record<NavigationIconName, string> = {
  assistant: 'M8 10h8m-8 4h5M8 3h8a4 4 0 0 1 4 4v9a4 4 0 0 1-4 4H9l-5 2V7a4 4 0 0 1 4-4Z',
  contacts: 'M4 3h14v18H4V3Zm14 4h3m-3 5h3m-3 5h3M8 16v-1a3 3 0 0 1 6 0v1M13 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  investments: 'M3 20h18M5 16v-5m7 5V7m7 9V3M4 7l6-4 5 2 5-4',
  schedule: 'M8 2v4m8-4v4M4 10h16M6 4h12a2 2 0 0 1 2 2v14H4V6a2 2 0 0 1 2-2Zm3 10h3m-3 4h6',
  review: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m11-13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm5 3 2 2 3-4',
  overview: 'M3 10 12 3l9 7M5 9v12h14V9M9 21v-7h6v7',
  bills: 'M5 3h14v19l-4-2-3 2-3-2-4 2V3Zm4 5h6m-6 4h6m-6 4h3',
  cards: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm-2 5h20M6 15h4',
  subscriptions: 'M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5m-4 9a8 8 0 0 0 14 2l3-3m0 5v-5h-5',
  runs: 'M5 5h14v14H5V5Zm4 3 6 4-6 4V8Z',
  audit: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8m-8 4h5',
  security: 'm12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Zm-4 10 3 3 5-6',
};

export default function NavigationIcon({ name }: { name: NavigationIconName }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
