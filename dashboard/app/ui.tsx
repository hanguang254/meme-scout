'use client';

import {
  AlertDialog as HeroAlertDialog,
  Button as HeroButton,
  Input as HeroInput,
  Modal as HeroModal,
  Tabs as HeroTabs,
} from '@heroui/react';
import { createContext, useContext } from 'react';
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react';
import { Text } from 'react-aria-components/Text';

const classes = (base: string, extra?: string) =>
  extra ? `${base} ${extra}` : base;

type ButtonVariant =
  | 'default'
  | 'outline'
  | 'ghost'
  | 'destructive'
  | 'secondary'
  | 'link';
type ButtonSize =
  | 'default'
  | 'xs'
  | 'sm'
  | 'lg'
  | 'icon'
  | 'icon-xs'
  | 'icon-sm'
  | 'icon-lg';

export type ButtonProps = Omit<
  ComponentProps<typeof HeroButton>,
  'variant' | 'size' | 'className' | 'render'
> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  className?: string;
  title?: string;
};

const buttonVariants = {
  default: 'primary',
  outline: 'outline',
  ghost: 'ghost',
  destructive: 'danger',
  secondary: 'secondary',
  link: 'ghost',
} as const;

export function Button({
  variant = 'default',
  size = 'default',
  disabled,
  isDisabled,
  isIconOnly,
  className,
  title,
  ...props
}: ButtonProps) {
  const heroSize =
    size === 'lg' || size === 'icon-lg'
      ? 'lg'
      : size === 'sm' ||
          size === 'xs' ||
          size === 'icon-sm' ||
          size === 'icon-xs'
        ? 'sm'
        : 'md';

  return (
    <HeroButton
      {...props}
      className={classes('scout-button', className)}
      variant={buttonVariants[variant]}
      size={heroSize}
      isDisabled={isDisabled ?? disabled}
      isIconOnly={isIconOnly ?? size.startsWith('icon')}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      render={(domProps) => <button {...domProps} title={title} />}
    />
  );
}

export function Input({
  className,
  ...props
}: Omit<ComponentProps<typeof HeroInput>, 'className'> & {
  className?: string;
}) {
  return (
    <HeroInput
      {...props}
      className={classes('scout-input', className)}
      data-slot="input"
    />
  );
}

type TabsProps = Omit<
  ComponentProps<typeof HeroTabs>,
  'selectedKey' | 'defaultSelectedKey' | 'onSelectionChange'
> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

export function Tabs({
  value,
  defaultValue,
  onValueChange,
  className,
  ...props
}: TabsProps) {
  return (
    <HeroTabs
      {...props}
      className={classes('scout-tabs', className)}
      selectedKey={value}
      defaultSelectedKey={defaultValue}
      onSelectionChange={(key) => onValueChange?.(String(key))}
    />
  );
}

export function TabsList({
  variant = 'line',
  className,
  'aria-label': ariaLabel = '候选筛选',
  ...props
}: ComponentProps<typeof HeroTabs.List> & {
  variant?: 'line' | 'default';
}) {
  return (
    <HeroTabs.List
      {...props}
      aria-label={ariaLabel}
      className={classes('scout-tabs-list', className)}
      data-variant={variant}
    />
  );
}

export function TabsTrigger({
  value,
  disabled,
  isDisabled,
  className,
  title,
  ...props
}: Omit<ComponentProps<typeof HeroTabs.Tab>, 'id' | 'render'> & {
  value: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <HeroTabs.Tab
      {...props}
      id={value}
      isDisabled={isDisabled ?? disabled}
      className={classes('scout-tabs-trigger', className)}
      render={(domProps, state) =>
        'href' in domProps ? (
          <a
            {...domProps}
            title={title}
            data-slot="tabs-trigger"
            data-state={state.isSelected ? 'active' : 'inactive'}
          />
        ) : (
          <div
            {...domProps}
            title={title}
            data-slot="tabs-trigger"
            data-state={state.isSelected ? 'active' : 'inactive'}
          />
        )
      }
    />
  );
}

type OverlayProps = {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const OverlayContext = createContext<{
  isOpen: boolean;
  onOpenChange?: (open: boolean) => void;
} | null>(null);

export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  children,
}: OverlayProps) {
  const controlled = open === undefined ? null : { isOpen: open, onOpenChange };
  return (
    <OverlayContext.Provider value={controlled}>
      {controlled ? (
        children
      ) : (
        <HeroModal defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
          {children}
        </HeroModal>
      )}
    </OverlayContext.Provider>
  );
}

export function DialogTrigger({ onPress, ...props }: ButtonProps) {
  const controlled = useContext(OverlayContext);
  return (
    <Button
      {...props}
      data-slot="dialog-trigger"
      onPress={(event) => {
        onPress?.(event);
        controlled?.onOpenChange?.(true);
      }}
    />
  );
}

export function DialogContent({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof HeroModal.Dialog>, 'children'> & {
  children?: ReactNode;
}) {
  const controlled = useContext(OverlayContext);
  return (
    <HeroModal.Backdrop
      {...(controlled ?? {})}
      className="scout-dialog-backdrop"
      data-slot="dialog-overlay"
    >
      <HeroModal.Container
        className="scout-dialog-container"
        placement="center"
      >
        <HeroModal.Dialog
          {...props}
          className={classes('scout-dialog', className)}
          data-slot="dialog-content"
        >
          {children}
          <HeroModal.CloseTrigger aria-label="关闭" />
        </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  );
}

export function DialogHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <HeroModal.Header
      {...props}
      className={classes('scout-dialog-header', className)}
      data-slot="dialog-header"
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof HeroModal.Heading>) {
  return (
    <HeroModal.Heading
      {...props}
      className={classes('scout-dialog-title', className)}
      data-slot="dialog-title"
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof Text>) {
  return (
    <Text
      {...props}
      elementType="p"
      slot="description"
      className={classes('scout-dialog-description', className)}
      data-slot="dialog-description"
    />
  );
}

export function AlertDialog({
  open,
  defaultOpen,
  onOpenChange,
  children,
}: OverlayProps) {
  const controlled = open === undefined ? null : { isOpen: open, onOpenChange };
  return (
    <OverlayContext.Provider value={controlled}>
      {controlled ? (
        children
      ) : (
        <HeroAlertDialog defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
          {children}
        </HeroAlertDialog>
      )}
    </OverlayContext.Provider>
  );
}

export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof HeroAlertDialog.Dialog>) {
  const controlled = useContext(OverlayContext);
  return (
    <HeroAlertDialog.Backdrop
      {...(controlled ?? {})}
      className="scout-dialog-backdrop"
      data-slot="alert-dialog-overlay"
      isDismissable={false}
      isKeyboardDismissDisabled={false}
    >
      <HeroAlertDialog.Container
        className="scout-dialog-container"
        placement="center"
      >
        <HeroAlertDialog.Dialog
          {...props}
          className={classes('scout-alert-dialog', className)}
          data-slot="alert-dialog-content"
        />
      </HeroAlertDialog.Container>
    </HeroAlertDialog.Backdrop>
  );
}

export function AlertDialogHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <HeroAlertDialog.Header
      {...props}
      className={classes('scout-dialog-header', className)}
      data-slot="alert-dialog-header"
    />
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof HeroAlertDialog.Heading>) {
  return (
    <HeroAlertDialog.Heading
      {...props}
      className={classes('scout-dialog-title', className)}
      data-slot="alert-dialog-title"
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof Text>) {
  return (
    <Text
      {...props}
      elementType="p"
      slot="description"
      className={classes('scout-dialog-description', className)}
      data-slot="alert-dialog-description"
    />
  );
}

export function AlertDialogFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <HeroAlertDialog.Footer
      {...props}
      className={classes('scout-dialog-footer', className)}
      data-slot="alert-dialog-footer"
    />
  );
}

export function AlertDialogCancel(props: ButtonProps) {
  return <Button variant="outline" {...props} slot="close" />;
}

// The page closes the controlled dialog only after its request succeeds.
export function AlertDialogAction(props: ButtonProps) {
  return <Button variant="destructive" {...props} slot={null} />;
}
