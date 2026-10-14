import type { ReactNode } from 'react';
import { LocaleText } from '@/lib/i18n/LocaleText';

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  align?: 'left' | 'right' | 'center';
  render?: (row: T) => ReactNode;
  className?: string;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  empty?: ReactNode;
  className?: string;
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const ALIGN_CLASS: Record<'left' | 'right' | 'center', string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

export function Table<T>({ columns, rows, rowKey, empty, className }: TableProps<T>) {
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-banking-light bg-white', className)}>
      <table className="w-full text-sm">
        <thead className="bg-banking-light text-banking-navy">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'px-4 py-3 font-semibold',
                  ALIGN_CLASS[column.align ?? 'left'],
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-gray-700">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-gray-500">
                {empty ?? <LocaleText messageKey="ui.noData" />}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                className="border-b border-banking-light transition-colors last:border-b-0 hover:bg-banking-light"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      'px-4 py-3',
                      ALIGN_CLASS[column.align ?? 'left'],
                      column.className,
                    )}
                  >
                    {column.render
                      ? column.render(row)
                      : (row as Record<string, ReactNode>)[column.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
