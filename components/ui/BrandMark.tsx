'use client';

import Image from 'next/image';
import { useTheme } from '@/lib/theme/ThemeProvider';

/** The dark variant changes only the charcoal strokes; the original logo remains untouched. */
export function BrandMark({ width, height, className }: { width: number; height: number; className?: string }) {
  const { theme } = useTheme();
  return <picture>
    <source srcSet="/brand/omni-x-dark.svg" media={theme === 'system' ? '(prefers-color-scheme: dark)' : theme === 'dark' ? 'all' : 'not all'} />
    <Image data-brand-mark src="/brand/omni-x.svg" alt="" width={width} height={height} className={className} />
  </picture>;
}
