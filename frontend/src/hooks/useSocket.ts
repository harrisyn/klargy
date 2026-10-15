'use client';

import { useEffect, useRef, useCallback } from 'react';
import type Pusher from 'pusher-js';
import type { Channel } from 'pusher-js';
import { getRuntimeConfig } from '@/lib/runtimeConfig';

/**
 * Real-time queue updates over the Pusher Channels protocol (Pusher, Ably,
 * or Soketi locally - see src/server/lib/realtime.ts). Same API the pages
 * used with Socket.IO: join a queue/location/user/service, subscribe to
 * events, get an unsubscribe function back.
 *
 * Events only carry IDs and statuses; handlers refetch what they need. When
 * no realtime key is configured, joined channels get a synthetic
 * `queue.updated` every POLL_MS so pages still refresh.
 */

const POLL_MS = 15000;

const EVENTS = ['queue.updated', 'entry.status_changed', 'notification.sent', 'serviceflow.transition', 'slot.released', 'location.updated'] as const;
type EventName = (typeof EVENTS)[number];
type Handler = (data: any) => void;

let pusherPromise: Promise<Pusher> | null = null;

function getPusher(): Promise<Pusher> | null {
  const cfg = getRuntimeConfig();
  if (!cfg.realtimeKey || typeof window === 'undefined') return null;
  if (!pusherPromise) {
    pusherPromise = import('pusher-js').then(({ default: PusherClient }) => {
      const host = cfg.realtimeHost;
      return new PusherClient(cfg.realtimeKey, host
        ? {
            cluster: cfg.realtimeCluster,
            wsHost: host,
            wsPort: Number(cfg.realtimePort || 6001),
            wssPort: Number(cfg.realtimePort || 443),
            forceTLS: cfg.realtimeTls,
            enabledTransports: ['ws', 'wss'],
            disableStats: true,
          }
        : { cluster: cfg.realtimeCluster });
    });
  }
  return pusherPromise;
}

export const useSocket = () => {
  const handlers = useRef(new Map<EventName, Set<Handler>>());
  const channels = useRef(new Map<string, Channel | null>());
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const dispatch = useCallback((event: EventName, data: unknown) => {
    handlers.current.get(event)?.forEach((h) => h(data));
  }, []);

  const join = useCallback((channelName: string, context: Record<string, string>) => {
    if (channels.current.has(channelName)) return;
    channels.current.set(channelName, null);

    const pusher = getPusher();
    if (!pusher) {
      // Polling fallback: nudge subscribers so they refetch.
      if (!pollTimer.current) {
        pollTimer.current = setInterval(() => {
          channels.current.forEach((_c, name) => {
            const [kind, ...rest] = name.split('-');
            const id = rest.join('-');
            dispatch('queue.updated', { action: 'poll', ...(kind === 'queue' ? { queueId: id } : {}), ...(kind === 'location' ? { locationId: id } : {}) });
          });
        }, POLL_MS);
      }
      return;
    }

    pusher.then((client) => {
      if (!channels.current.has(channelName)) return; // left before connecting
      const channel = client.subscribe(channelName);
      EVENTS.forEach((event) => channel.bind(event, (data: unknown) => dispatch(event, { ...context, ...(data as object) })));
      channels.current.set(channelName, channel);
    });
  }, [dispatch]);

  const leave = useCallback((channelName: string) => {
    const channel = channels.current.get(channelName);
    channels.current.delete(channelName);
    if (channel) {
      channel.unbind_all();
      getPusher()?.then((client) => client.unsubscribe(channelName));
    }
  }, []);

  useEffect(() => {
    const joined = channels.current;
    return () => {
      Array.from(joined.keys()).forEach(leave);
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
  }, [leave]);

  const joinQueue = useCallback((queueId: string) => join(`queue-${queueId}`, { queueId }), [join]);
  const leaveQueue = useCallback((queueId: string) => leave(`queue-${queueId}`), [leave]);
  const joinUser = useCallback((userId: string) => join(`user-${userId}`, {}), [join]);
  const joinService = useCallback((serviceId: string) => join(`service-${serviceId}`, {}), [join]);
  const joinLocation = useCallback((locationId: string) => join(`location-${locationId}`, { locationId }), [join]);

  const on = useCallback((event: EventName, callback: Handler) => {
    if (!handlers.current.has(event)) handlers.current.set(event, new Set());
    handlers.current.get(event)!.add(callback);
    return () => { handlers.current.get(event)?.delete(callback); };
  }, []);

  const onQueueUpdated = useCallback(
    (callback: (data: { queueId: string; action: string }) => void) => on('queue.updated', callback),
    [on]
  );
  const onEntryStatusChanged = useCallback(
    (callback: (data: { queueId: string; entryId: string; status: string }) => void) => on('entry.status_changed', callback),
    [on]
  );
  const onNotification = useCallback(
    (callback: (data: { message: string }) => void) => on('notification.sent', callback),
    [on]
  );
  const onServiceFlowTransition = useCallback((callback: (data: unknown) => void) => on('serviceflow.transition', callback), [on]);
  const onLocationUpdated = useCallback((callback: (data: { locationId?: string; type?: string }) => void) => on('location.updated', callback), [on]);

  return {
    joinQueue,
    leaveQueue,
    joinUser,
    joinService,
    joinLocation,
    onQueueUpdated,
    onEntryStatusChanged,
    onNotification,
    onServiceFlowTransition,
    onLocationUpdated,
  };
};

export default useSocket;
