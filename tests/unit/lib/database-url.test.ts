import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '@/lib/db/url';

describe('shared SQLite target resolution', () => {
  it('resolves relative filenames against the schema folder for both CLI and native adapter', () => {
    expect(resolveDatabaseUrl('file:./demo.db', process.cwd())).toBe('file:' + path.join(process.cwd(), 'prisma', 'demo.db'));
  });
  it('preserves an absolute isolated target and removes obsolete runtime pool parameters', () => {
    const target = path.join(process.cwd(), 'prisma', 'test.db');
    expect(resolveDatabaseUrl('file:' + target + '?connection_limit=1')).toBe('file:' + target);
  });
  it('keeps in-memory clients isolated instead of creating a disk file named :memory:', () => {
    expect(resolveDatabaseUrl('file::memory:')).toBe('file::memory:');
  });
  it.each(['postgresql://remote/database', 'file:'])('rejects an unsupported target %s', target => {
    expect(() => resolveDatabaseUrl(target)).toThrow();
  });
});
