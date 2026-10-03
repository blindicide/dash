/**
 * Thin adapters over the host SDK's design-system components (Button, Badge, Dialog) with
 * native fallbacks for hosts that do not expose them. Keeps dash visually native to the
 * active Hermes theme without depending on undocumented props.
 */
import { useEffect, useRef, type ComponentType, type ReactNode } from "react";

type AnyComp = ComponentType<Record<string, unknown>>;

function hostComponent(name: string): AnyComp | null {
  const c = typeof window !== "undefined" ? window.__HERMES_PLUGIN_SDK__?.components?.[name] : undefined;
  return (c as unknown as AnyComp) ?? null;
}

// Resolved once at bundle load: the host exposes its SDK before any plugin script runs.
const HostButton = hostComponent("Button");
const HostBadge = hostComponent("Badge");
const HostDialog = {
  Root: hostComponent("Dialog"),
  Content: hostComponent("DialogContent"),
  Header: hostComponent("DialogHeader"),
  Title: hostComponent("DialogTitle"),
  Description: hostComponent("DialogDescription"),
  Footer: hostComponent("DialogFooter"),
};

export interface BtnProps {
  children?: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  type?: "button" | "submit";
  variant?: "primary" | "ghost" | "outlined" | "destructive";
  size?: "sm" | "default" | "icon" | "xs";
  className?: string;
  title?: string;
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "menu" | "dialog" | boolean;
  "aria-controls"?: string;
}

export function Btn({ variant = "primary", size = "default", className, type = "button", ...rest }: BtnProps) {
  const Host = HostButton;
  const cls = `dash-btn dash-btn--${variant} dash-btn--${size}${className ? ` ${className}` : ""}`;
  if (Host) {
    return (
      <Host
        {...rest}
        type={type}
        className={cls}
        size={size}
        ghost={variant === "ghost" || undefined}
        outlined={variant === "outlined" || undefined}
        destructive={variant === "destructive" || undefined}
      />
    );
  }
  return <button {...rest} type={type} className={cls} />;
}

export function Badge({
  children,
  tone = "default",
  className,
  title,
}: {
  children: ReactNode;
  tone?: "default" | "destructive" | "outline" | "secondary" | "success" | "warning";
  className?: string;
  title?: string;
}) {
  const Host = HostBadge;
  const cls = `dash-badge dash-badge--${tone}${className ? ` ${className}` : ""}`;
  return Host ? (
    <Host tone={tone} className={cls} title={title}>
      {children}
    </Host>
  ) : (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, description, children, footer, className }: ModalProps) {
  const { Root: D, Content: DC, Header: DH, Title: DT, Description: DD, Footer: DF } = HostDialog;
  if (D && DC && DH && DT) {
    return (
      <D open={open} onOpenChange={(o: boolean) => (!o ? onClose() : undefined)}>
        <DC className={`dash-dialog ${className ?? ""}`}>
          <DH>
            <DT>{title}</DT>
            {description && DD ? <DD>{description}</DD> : null}
          </DH>
          <div className="dash-dialog__body">{children}</div>
          {footer ? DF ? <DF>{footer}</DF> : <div className="dash-dialog__footer">{footer}</div> : null}
        </DC>
      </D>
    );
  }
  return <FallbackModal {...{ open, onClose, title, description, children, footer, className }} />;
}

function FallbackModal({ open, onClose, title, description, children, footer, className }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
    if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dash-dialog dash-dialog--native ${className ?? ""}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 className="dash-dialog__title">{title}</h2>
      {description ? <p className="dash-muted">{description}</p> : null}
      <div className="dash-dialog__body">{children}</div>
      {footer ? <div className="dash-dialog__footer">{footer}</div> : null}
    </dialog>
  );
}
