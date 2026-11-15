import {
  Children,
  forwardRef,
  isValidElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ResourceOption, ResourceSelect } from "./resource-picker";

function optionText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? optionText(child.props.children)
        : String(child),
    )
    .join("");
}

export function resourceOptions(children: ReactNode, groupDisabled = false): ResourceOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{
        children?: ReactNode;
        value?: string | number;
        disabled?: boolean;
        "data-description"?: string;
      }>(child)
    )
      return [];
    if (child.type === "option")
      return [
        {
          value: String(child.props.value ?? optionText(child.props.children)),
          label: optionText(child.props.children),
          disabled: groupDisabled || child.props.disabled,
          description: child.props["data-description"],
        },
      ];
    return resourceOptions(child.props.children, groupDisabled || child.props.disabled);
  });
}

interface ResourceSelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  searchable?: boolean;
  recent?: boolean;
  resourceType?: string;
  expandable?: boolean;
  presentation?: "dropdown" | "dialog";
}

// Preserve the existing native change event, FormData and validation contract while migrating callers.
export const ResourceSelectField = forwardRef<HTMLSelectElement, ResourceSelectFieldProps>(
  (
    {
      children,
      id,
      className,
      searchable = true,
      recent = false,
      resourceType = "resource",
      expandable = false,
      presentation,
      ...props
    },
    ref,
  ) => {
    const nativeRef = useRef<HTMLSelectElement>(null);
    const triggerRef = useRef<HTMLSpanElement>(null);
    useImperativeHandle(ref, () => nativeRef.current as HTMLSelectElement);
    const options = useMemo(() => resourceOptions(children), [children]);
    const [uncontrolledValue, setUncontrolledValue] = useState(
      String(props.defaultValue ?? options[0]?.value ?? ""),
    );
    const value = String(props.value ?? uncontrolledValue);
    useEffect(() => {
      if (
        props.value === undefined &&
        !options.some((option) => option.value === uncontrolledValue)
      ) {
        setUncontrolledValue(nativeRef.current?.value ?? "");
      }
    }, [props.value, options, uncontrolledValue]);
    useEffect(() => {
      const control = nativeRef.current;
      if (props.value !== undefined || !control) return;
      setUncontrolledValue(control.value);
      const reset = () => queueMicrotask(() => setUncontrolledValue(control.value));
      control.form?.addEventListener("reset", reset);
      return () => control.form?.removeEventListener("reset", reset);
    }, [props.value]);
    return (
      <span ref={triggerRef} className="contents">
        <ResourceSelect
          id={id}
          options={options}
          value={value}
          onValueChange={(next) => {
            const control = nativeRef.current;
            if (!control || control.disabled) return;
            setUncontrolledValue(next);
            control.value = next;
            control.dispatchEvent(new Event("change", { bubbles: true }));
          }}
          className={className}
          disabled={props.disabled}
          label={props["aria-label"]}
          aria-required={props.required}
          aria-labelledby={props["aria-labelledby"]}
          aria-describedby={props["aria-describedby"]}
          aria-invalid={props["aria-invalid"]}
          searchable={searchable}
          recent={recent}
          resourceType={resourceType}
          expandable={expandable}
          presentation={presentation}
          data-testid={
            props["data-testid" as keyof typeof props]
              ? `${props["data-testid" as keyof typeof props]}-trigger`
              : undefined
          }
        />
        <select
          {...props}
          ref={nativeRef}
          id={id ? `${id}-native` : undefined}
          aria-hidden
          aria-label={undefined}
          aria-labelledby={undefined}
          tabIndex={-1}
          className="sr-only"
          onInvalid={(event) => {
            event.preventDefault();
            triggerRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
            props.onInvalid?.(event);
          }}
        >
          {children}
        </select>
      </span>
    );
  },
);
ResourceSelectField.displayName = "ResourceSelectField";
