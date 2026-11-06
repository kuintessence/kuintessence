import { Search } from "lucide-react";
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";
import { Input } from "./input";

interface SearchInputProps extends InputHTMLAttributes<HTMLInputElement> {
  containerClassName?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, containerClassName, ...props }, ref) => (
    <span className={cn("relative block min-w-0", containerClassName)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input ref={ref} className={cn("pl-8", className)} {...props} />
    </span>
  ),
);
SearchInput.displayName = "SearchInput";
