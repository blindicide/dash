/* Build-time alias target for `react/jsx-runtime`: the host SDK exposes React but not its JSX
 * runtime, so the automatic runtime is implemented on top of createElement. `key` is passed
 * back through props, which createElement extracts exactly like the real runtime. */
import React from "./react";

type Props = Record<string, unknown> | null;

export const Fragment = React.Fragment;

export function jsx(type: React.ElementType, props: Props, key?: React.Key) {
  return React.createElement(type, key === undefined ? props : { ...(props ?? {}), key });
}

export const jsxs = jsx;
export const jsxDEV = jsx;
