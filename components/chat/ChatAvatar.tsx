'use client';

import { useId } from 'react';

/** Local vector portraits stay crisp at chat size and make no external image requests. */
export function ChatAvatar({ role }: { role: 'assistant' | 'user' }) {
  const id = useId();
  const background = `${id}-background`;
  const face = `${id}-face`;
  const clip = `${id}-clip`;
  const assistant = role === 'assistant';
  return <span aria-hidden="true" data-chat-avatar={role}
    className="mt-5 inline-flex h-7 w-7 shrink-0 overflow-hidden rounded-full ring-2 ring-white shadow-sm sm:h-9 sm:w-9">
    <svg viewBox="0 0 48 48" fill="none" className="h-full w-full">
      <defs>
        <linearGradient id={background} x1="4" y1="0" x2="44" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor={assistant ? '#EF9A9C' : '#FFE5C5'} />
          <stop offset="1" stopColor={assistant ? '#C8383C' : '#EFAF8B'} />
        </linearGradient>
        <linearGradient id={face} x1="14" y1="15" x2="34" y2="36" gradientUnits="userSpaceOnUse">
          <stop stopColor={assistant ? '#FFFFFF' : '#FFE0BA'} />
          <stop offset="1" stopColor={assistant ? '#FFF0ED' : '#F2B18B'} />
        </linearGradient>
        <clipPath id={clip}><circle cx="24" cy="24" r="24" /></clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <circle cx="24" cy="24" r="24" fill={`url(#${background})`} />
        <circle cx="8" cy="8" r="17" fill="white" fillOpacity=".12" />
        {assistant ? <>
          <path d="M24 11v5" stroke="#FFF0ED" strokeWidth="2" strokeLinecap="round" />
          <circle cx="24" cy="10" r="2.5" fill="#FFE6A6" />
          <rect x="8" y="22" width="5" height="10" rx="2.5" fill="#F6C6C5" />
          <rect x="35" y="22" width="5" height="10" rx="2.5" fill="#F6C6C5" />
          <rect x="11" y="16" width="26" height="23" rx="10" fill="#6E2227" fillOpacity=".17" />
          <rect x="11" y="15" width="26" height="23" rx="10" fill={`url(#${face})`} />
          <rect x="16" y="22" width="4" height="6" rx="2" fill="#57383C" />
          <rect x="28" y="22" width="4" height="6" rx="2" fill="#57383C" />
          <circle cx="16" cy="30" r="2" fill="#ED969B" fillOpacity=".55" />
          <circle cx="32" cy="30" r="2" fill="#ED969B" fillOpacity=".55" />
          <path d="M21 31c1.6 1.7 4.4 1.7 6 0" stroke="#57383C" strokeWidth="1.8" strokeLinecap="round" />
          <path d="m37 9 1.2 2.8L41 13l-2.8 1.2L37 17l-1.2-2.8L33 13l2.8-1.2L37 9Z" fill="#FFF1BD" />
        </> : <>
          <path d="M7 49c.6-9.3 6.5-15 17-15s16.4 5.7 17 15" fill="#51464B" />
          <path d="M19 32h10v5c-2.9 3.2-7.1 3.2-10 0v-5Z" fill="#EDAE89" />
          <path d="M12 21c0-9 4.4-13 12-13 8.1 0 12 5.3 12 13v7H12v-7Z" fill="#433C3A" />
          <ellipse cx="24" cy="24" rx="10" ry="12" fill={`url(#${face})`} />
          <path d="M14 23c-1-8 1.7-13 10-13 6.5 0 10.5 4.5 10 12-5-1-9.1-3.8-11-7-1.7 4.2-4.8 6.3-9 8Z" fill="#433C3A" />
          <circle cx="20" cy="25" r="1.2" fill="#59413A" />
          <circle cx="28" cy="25" r="1.2" fill="#59413A" />
          <path d="M21 30c1.8 1.4 4.2 1.4 6 0" stroke="#AD6858" strokeWidth="1.6" strokeLinecap="round" />
          <path d="m17 38 7 5 7-5" stroke="#E3A0A5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>}
      </g>
    </svg>
  </span>;
}
