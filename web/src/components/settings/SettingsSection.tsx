/** A titled group of related settings. In the master-detail layout only one
 *  section is visible at a time, so it no longer needs inter-section borders.
 *
 *  Extracted from the prior 3,314-line SettingsPage god-component (WARDEN-664).
 *  Each per-section component wraps its body in this so the DOM matches the
 *  prior inline `<SettingsSection>` usage exactly (a `<section>` direct child
 *  of the gap-6 content pane). */
import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SettingsSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {children}
    </section>
  );
}
