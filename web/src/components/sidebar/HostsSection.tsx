// Hosts section — job B of the rebuilt sidebar (WARDEN-1422): HOSTS are the
// primary navigation, top of root, green accent. Every host row carries its
// LIVE agent count — designed for 20+ active agents per host across several
// hosts: the count carries that load, not a row list. The section header shows
// the fleet total ("78 live" in the exhibit). Offline hosts keep their own
// treatment: a red square dot, the word "offline", and their saved count —
// their sessions are unknown, not absent.

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { StatusDot } from '@/components/StatusDot';
import { copyWithToast } from '@/lib/clipboardToast';
import { hostLabelFor, THIS_MACHINE } from '@/lib/chatDisplay';
import { useHostLabels } from '@/lib/uiStore';
import type { Chat } from '@/lib/types';

export type HostStatusMap = Record<string, { status: 'online' | 'offline' | 'unknown'; latency_ms: number | null }>;

export interface HostsSectionProps {
  hosts: string[];
  // The SAVED sessions (temporaries are never listed — the saved count is "how
  // many sessions will I find in this host's list").
  chats: Chat[];
  // The running UNSAVED shells, counted into the LIVE number but never listed:
  // the exhibit's hosts carry live ≫ saved (78 live, 1–6 saved) precisely
  // because the count carries the 20+-agents-per-host load the row list must not.
  tempChats: Chat[];
  hostStatuses: HostStatusMap;
  onEnterHost: (host: string) => void;
  onDiscoverHost: (host: string) => void;
}

export function HostsSection({ hosts, chats, tempChats, hostStatuses, onEnterHost, onDiscoverHost }: HostsSectionProps) {
  const hostLabels = useHostLabels();
  const hostRows = hosts.map((h) => {
    const hostChats = chats.filter((c) => c.host === h);
    const live = hostChats.filter((c) => c.active).length + tempChats.filter((c) => c.host === h).length;
    const offline = hostStatuses[h]?.status === 'offline';
    return { host: h, label: hostLabelFor(h, hostLabels) || (h === THIS_MACHINE ? 'this machine' : h), live, saved: hostChats.length, offline, isLocal: h === THIS_MACHINE };
  });
  const totalLive = hostRows.reduce((a, r) => a + r.live, 0);
  // Online hosts keep discovery order; offline hosts sink (and carry their own
  // treatment), mirroring the exhibit.
  const ordered = [...hostRows.filter((r) => !r.offline), ...hostRows.filter((r) => r.offline)];

  return (
    <>
      <div className="flex items-baseline gap-1.5 px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-green-500">
        hosts
        <span className="ml-auto font-normal normal-case tracking-normal text-muted-foreground">{totalLive} live</span>
      </div>
      <div className="flex flex-col gap-0.5 px-1 pb-1">
        {ordered.map((r) => (
          <ContextMenu key={r.host}>
            <ContextMenuTrigger asChild>
              <button
                onClick={() => onEnterHost(r.host)}
                aria-label={`host ${r.label} — ${r.offline ? 'offline' : `${r.live} live`}, ${r.saved} saved`}
                className="flex min-w-0 items-center gap-[7px] rounded-[7px] px-1.5 py-1.5 text-left text-[11.5px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                data-testid={`host-row-${r.host}`}
              >
                <StatusDot
                  tone={r.offline ? 'red' : r.live ? 'green' : 'muted'}
                  variant={r.offline ? 'square' : r.live ? 'solid' : 'ring'}
                  label={r.offline ? 'host offline — unreachable' : r.live ? `${r.live} live` : 'no live sessions'}
                />
                <span className="min-w-0 flex-1 wrap-anywhere">{r.label}</span>
                {r.offline ? (
                  <span className="flex-none text-[10px] text-muted-foreground">offline</span>
                ) : (
                  <span className="flex-none text-[10px] text-green-500">{r.live} live</span>
                )}
                <span className="flex-none text-[10px] text-muted-foreground @max-[13rem]:hidden">{r.saved} saved</span>
                <span className="flex-none text-[11px] text-muted-foreground" aria-hidden="true">›</span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => onEnterHost(r.host)}>Open</ContextMenuItem>
              <ContextMenuItem onSelect={() => onDiscoverHost(r.host)}>Discover</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => copyWithToast(r.label)}>Copy host name</ContextMenuItem>
              {!r.isLocal && <ContextMenuItem onSelect={() => copyWithToast(`ssh ${r.host}`)}>Copy SSH address</ContextMenuItem>}
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
    </>
  );
}
