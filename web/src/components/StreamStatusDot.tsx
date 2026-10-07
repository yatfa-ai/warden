import { useEffect, useState } from 'react';
import { streamApi } from '@/lib/stream';
import { StatusDot } from '@/components/StatusDot';

/**
 * Header websocket-connection dot (WARDEN-1634, client-state slice 40).
 *
 * Owns the connection state so a websocket open/close re-renders only this dot,
 * not all of App. `streamApi.onOpen/onClose` are single-slot assignments, so this
 * component must be their ONLY assigner.
 *
 * The header is unmounted while Settings is open, so local state is torn down:
 * seed from `streamApi.ready` and re-sync on mount so the dot shows the live state
 * on return from Settings instead of a stale "Disconnected".
 */
export function StreamStatusDot() {
  const [conn, setConn] = useState(() => streamApi.ready);

  useEffect(() => {
    streamApi.onOpen = () => setConn(true);
    streamApi.onClose = () => setConn(false);
    setConn(streamApi.ready);
    return () => {
      streamApi.onOpen = null;
      streamApi.onClose = null;
    };
  }, []);

  return (
    <StatusDot
      tone={conn ? 'green' : 'red'}
      variant={conn ? 'solid' : 'ring'}
      label={conn ? 'Connected' : 'Disconnected'}
      className="transition-colors duration-300 ease-in-out"
    />
  );
}
