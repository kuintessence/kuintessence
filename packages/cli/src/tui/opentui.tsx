import { type KeyEvent, TextAttributes } from "@opentui/core";
import {
  type BoxProps as OpenBoxProps,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { createContext, type ReactNode, useContext } from "react";

interface BoxProps {
  children?: ReactNode;
  flexDirection?: "row" | "column";
  justifyContent?: OpenBoxProps["justifyContent"];
  borderStyle?: "round";
  borderColor?: string;
  paddingX?: number;
  marginY?: number;
  marginTop?: number;
  marginBottom?: number;
}

interface TextProps {
  children?: ReactNode;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  inverse?: boolean;
  dimColor?: boolean;
}

const TextParentContext = createContext(false);

export function Box({
  children,
  flexDirection = "row",
  justifyContent,
  borderStyle,
  borderColor,
  paddingX,
  marginY,
  marginTop,
  marginBottom,
}: BoxProps) {
  return (
    <box
      style={{
        flexDirection,
        ...(justifyContent ? { justifyContent } : {}),
        ...(borderStyle ? { border: true, borderStyle: "rounded" } : {}),
        ...(borderColor ? { borderColor } : {}),
        ...(paddingX !== undefined ? { paddingLeft: paddingX, paddingRight: paddingX } : {}),
        ...(marginY !== undefined ? { marginTop: marginY, marginBottom: marginY } : {}),
        ...(marginTop !== undefined ? { marginTop } : {}),
        ...(marginBottom !== undefined ? { marginBottom } : {}),
      }}
    >
      {children}
    </box>
  );
}

export function Text({ children, color, backgroundColor, bold, inverse, dimColor }: TextProps) {
  const nested = useContext(TextParentContext);
  const attributes =
    (bold ? TextAttributes.BOLD : 0) |
    (inverse ? TextAttributes.INVERSE : 0) |
    (dimColor ? TextAttributes.DIM : 0);
  const props = {
    ...(color ? { fg: color } : {}),
    ...(backgroundColor ? { bg: backgroundColor } : {}),
    ...(attributes ? { attributes } : {}),
  };
  if (nested) return <span {...props}>{children}</span>;
  return (
    <text {...props}>
      <TextParentContext.Provider value>{children}</TextParentContext.Provider>
    </text>
  );
}

interface InputKey {
  upArrow: boolean;
  downArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  escape: boolean;
  return: boolean;
  backspace: boolean;
  delete: boolean;
  tab: boolean;
  ctrl: boolean;
  meta: boolean;
}

function printableInput(key: KeyEvent): string {
  if (key.ctrl) return key.name.length === 1 ? key.name : "";
  if (key.name === "space") return " ";
  if (key.sequence.length === 1 && key.sequence >= " ") return key.sequence;
  return key.name.length === 1 ? key.name : "";
}

export function useInput(handler: (input: string, key: InputKey) => void): void {
  useKeyboard((event) => {
    handler(printableInput(event), {
      upArrow: event.name === "up",
      downArrow: event.name === "down",
      pageUp: event.name === "pageup",
      pageDown: event.name === "pagedown",
      escape: event.name === "escape",
      return: event.name === "return" || event.name === "enter",
      backspace: event.name === "backspace",
      delete: event.name === "delete",
      tab: event.name === "tab",
      ctrl: event.ctrl,
      meta: event.meta,
    });
  });
}

export function useApp(): { exit: () => void } {
  const renderer = useRenderer();
  return { exit: () => renderer.destroy() };
}

export function useStdout(): { stdout: { rows: number; columns: number } } {
  const { width, height } = useTerminalDimensions();
  return { stdout: { rows: height, columns: width } };
}
