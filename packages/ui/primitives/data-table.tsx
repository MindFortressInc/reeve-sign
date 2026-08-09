import { Trans } from '@lingui/react/macro';
import type {
  ColumnDef,
  PaginationState,
  Row,
  RowSelectionState,
  Table as TTable,
  Updater,
  VisibilityState,
} from '@tanstack/react-table';
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type React from 'react';
import { useMemo } from 'react';

import { cn } from '../lib/utils';
import { Skeleton } from './skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

export type DataTableChildren<TData> = (_table: TTable<TData>) => React.ReactNode;

export type { ColumnDef as DataTableColumnDef, RowSelectionState } from '@tanstack/react-table';

export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  columnVisibility?: VisibilityState;
  data: TData[];
  onRowClick?: (row: TData) => void;
  rowClassName?: string;
  perPage?: number;
  currentPage?: number;
  totalPages?: number;
  onPaginationChange?: (_page: number, _perPage: number) => void;
  onClearFilters?: () => void;
  emptyState?: React.ReactNode;
  hasFilters?: boolean;
  children?: DataTableChildren<TData>;
  skeleton?: {
    enable: boolean;
    rows: number;
    component?: React.ReactNode;
  };
  error?: {
    enable: boolean;
    component?: React.ReactNode;
  };
  enableRowSelection?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (selection: RowSelectionState) => void;
  getRowId?: (row: TData) => string;

  /**
   * When provided, the table is hidden below the `md` breakpoint and each row is
   * rendered as a stacked card using this renderer instead. The table renders
   * unchanged at `md` and above.
   */
  renderMobileCard?: (row: Row<TData>) => React.ReactNode;
}

export function DataTable<TData, TValue>({
  columns,
  columnVisibility,
  data,
  error,
  perPage,
  currentPage,
  totalPages,
  skeleton,
  hasFilters,
  onClearFilters,
  onPaginationChange,
  onRowClick,
  rowClassName,
  children,
  emptyState,
  enableRowSelection,
  rowSelection,
  onRowSelectionChange,
  getRowId,
  renderMobileCard,
}: DataTableProps<TData, TValue>) {
  const pagination = useMemo<PaginationState>(() => {
    if (currentPage !== undefined && perPage !== undefined) {
      return {
        pageIndex: currentPage - 1,
        pageSize: perPage,
      };
    }

    return {
      pageIndex: 0,
      pageSize: 0,
    };
  }, [currentPage, perPage]);

  const manualPagination = Boolean(currentPage !== undefined && totalPages !== undefined);

  const onTablePaginationChange = (updater: Updater<PaginationState>) => {
    if (typeof updater === 'function') {
      const newState = updater(pagination);

      onPaginationChange?.(newState.pageIndex + 1, newState.pageSize);
    } else {
      onPaginationChange?.(updater.pageIndex + 1, updater.pageSize);
    }
  };

  const onTableRowSelectionChange = (updater: Updater<RowSelectionState>) => {
    if (onRowSelectionChange) {
      const newSelection = typeof updater === 'function' ? updater(rowSelection ?? {}) : updater;
      onRowSelectionChange(newSelection);
    }
  };

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: {
      pagination: manualPagination ? pagination : undefined,
      columnVisibility,
      rowSelection: rowSelection ?? {},
    },
    manualPagination,
    pageCount: totalPages,
    onPaginationChange: onTablePaginationChange,
    enableRowSelection,
    onRowSelectionChange: onTableRowSelectionChange,
    getRowId,
  });

  const defaultEmptyState = (
    <>
      <p>
        <Trans>No results found</Trans>
      </p>

      {hasFilters && onClearFilters !== undefined && (
        <button onClick={() => onClearFilters()} className="mt-1 text-foreground text-sm">
          <Trans>Clear filters</Trans>
        </button>
      )}
    </>
  );

  return (
    <>
      <div className={cn('rounded-md border', renderMobileCard && 'hidden md:block')}>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                  className={rowClassName}
                  onClick={() => onRowClick?.(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      style={{
                        width: `${cell.column.getSize()}px`,
                      }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : error?.enable ? (
              <TableRow>
                {error.component ?? (
                  <TableCell colSpan={columns.length} className="h-32 text-center">
                    <Trans>Something went wrong.</Trans>
                  </TableCell>
                )}
              </TableRow>
            ) : skeleton?.enable ? (
              Array.from({ length: skeleton.rows }).map((_, i) => (
                <TableRow key={`skeleton-row-${i}`}>{skeleton.component ?? <Skeleton />}</TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-32 text-center">
                  {emptyState ?? defaultEmptyState}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Rendered after the table so locators that take the first match of a
          duplicated element (e.g. row action buttons) resolve to the visible
          desktop table copy rather than this hidden-on-desktop card list. */}
      {renderMobileCard && (
        <div className="space-y-4 md:hidden">
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <div
                key={row.id}
                data-state={row.getIsSelected() && 'selected'}
                className={cn('rounded-md border p-4', rowClassName)}
                onClick={() => onRowClick?.(row.original)}
              >
                {renderMobileCard(row)}
              </div>
            ))
          ) : error?.enable ? (
            error.component ?? (
              <div className="rounded-md border p-8 text-center">
                <Trans>Something went wrong.</Trans>
              </div>
            )
          ) : skeleton?.enable ? (
            Array.from({ length: skeleton.rows }).map((_, i) => (
              <div key={`mobile-skeleton-card-${i}`} className="space-y-3 rounded-md border p-4">
                <Skeleton className="h-4 w-40 rounded-full" />
                <Skeleton className="h-4 w-24 rounded-full" />
                <Skeleton className="h-10 w-32 rounded" />
              </div>
            ))
          ) : (
            <div className="rounded-md border p-8 text-center">{emptyState ?? defaultEmptyState}</div>
          )}
        </div>
      )}

      {children && <div className="mt-8 w-full">{children(table)}</div>}
    </>
  );
}
