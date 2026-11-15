import {
  forwardRef,
  type HTMLAttributes,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";
import { cn } from "../../lib/utils";

export const Table = forwardRef<HTMLTableElement, TableHTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <table ref={ref} className={cn("w-full text-left text-sm", className)} {...props} />
  ),
);
Table.displayName = "Table";
export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn("border-b border-border text-xs text-muted-foreground", className)}
    {...props}
  />
));
TableHeader.displayName = "TableHeader";
export const TableBody = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";
export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn("border-b border-border transition-colors", className)}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";
export const TableHead = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      scope="col"
      className={cn("px-4 py-3 text-left align-middle font-medium", className)}
      {...props}
    />
  ),
);
TableHead.displayName = "TableHead";
export const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("px-4 py-3 align-middle", className)} {...props} />
  ),
);
TableCell.displayName = "TableCell";
