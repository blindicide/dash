/* Build-time alias target for `react`: forwards to the Hermes Dashboard's React singleton
 * (window.__HERMES_PLUGIN_SDK__.React). Never bundles a second React. */
import type * as ReactNS from "react";

type ReactModule = typeof ReactNS;

const host = (typeof window !== "undefined" ? window.__HERMES_PLUGIN_SDK__?.React : undefined) as
  | ReactModule
  | undefined;
// When the SDK is missing, main.tsx refuses to register; this empty object only keeps module
// evaluation from throwing before that check runs.
const React = (host ?? ({} as ReactModule)) as ReactModule;

export default React;
export const {
  Children,
  Component,
  Fragment,
  StrictMode,
  Suspense,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} = React;
