/** Plain-text ledger note; keep long notes readable without widening the table. */
export function TransactionRemark({ remark }: { remark?: string }) {
  return <span data-transaction-remark className={`block w-16 whitespace-pre-wrap [overflow-wrap:anywhere] ${remark?.trim() ? 'text-banking-navy' : 'text-banking-navy/40'}`}>{remark?.trim() ? remark : '—'}</span>;
}
