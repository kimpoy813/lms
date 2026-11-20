// Reusable Web Push opt-in/opt-out control for Profile and Notifications.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from './toast.jsx';
import { Button, Card, Switch } from './ui.jsx';
import { api } from '../lib/api.js';
import { disableWebPush, enableWebPush, extractSubscriptionPayload, getActivePushSubscription, isPushSupported, subscriptionMatchesKey } from '../lib/pwa.js';

export default function PushNotificationsCard({ compact = false, hideWhenSubscribed = false }) {
  const client = useQueryClient();
  const config = useQuery({
    queryKey: ['notifications', 'push', 'config'],
    queryFn: () => api.get('/notifications/push/config'),
    staleTime: 60_000,
  });
  const publicKey = config.data?.publicKey ?? null;
  const serverDevices = config.data?.subscribedDevices;
  const supported = isPushSupported();
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [permission, setPermission] = useState(() => (typeof Notification !== 'undefined' ? Notification.permission : 'default'));

  useEffect(() => {
    if (!supported || !publicKey) return;
    let active = true;
    getActivePushSubscription()
      .then(async (sub) => {
        if (!active) return;
        const matched = Boolean(sub && subscriptionMatchesKey(sub, publicKey));
        if (matched && serverDevices === 0 && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try {
            await api.post('/notifications/push/subscribe', extractSubscriptionPayload(sub));
            if (active) client.invalidateQueries({ queryKey: ['notifications', 'push', 'config'] });
          } catch {
            // Ignore silent resync error; user can toggle manually.
          }
        }
        if (active) setSubscribed(matched);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [supported, publicKey, serverDevices, client]);

  const toggle = async (next) => {
    setBusy(true);
    try {
      if (next) {
        await enableWebPush(publicKey, api);
        setSubscribed(true);
        setPermission(Notification.permission);
        toast.success('Device alerts enabled for this browser.');
      } else {
        await disableWebPush(api);
        setSubscribed(false);
        toast.success('Device alerts turned off on this browser.');
      }
      client.invalidateQueries({ queryKey: ['notifications', 'push', 'config'] });
    } catch (err) {
      setPermission(typeof Notification !== 'undefined' ? Notification.permission : 'default');
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await api.post('/notifications/push/test', {});
      if (res.sent > 0) {
        toast.success('Test notification sent.');
      } else {
        const sub = await getActivePushSubscription().catch(() => null);
        setSubscribed(Boolean(sub && subscriptionMatchesKey(sub, publicKey)));
        client.invalidateQueries({ queryKey: ['notifications', 'push', 'config'] });
        toast.warning('No active push device was reached. Try turning alerts off and back on for this device.');
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setTesting(false);
    }
  };

  if (compact && (!publicKey || (hideWhenSubscribed && subscribed))) return null;

  const disabled = !publicKey || !supported || busy;
  const description = !publicKey
    ? (config.isLoading ? 'Checking device notification support…' : 'Push notifications are not configured on this server yet (VAPID keys required).')
    : !supported
      ? 'This browser does not support Web Push notifications.'
      : permission === 'denied'
        ? 'Notifications are blocked in your browser settings. Allow notifications for this site to enable alerts.'
        : 'Receive instant alerts for announcements, deadlines, returned grades, and live attendance check-ins.';

  if (compact) {
    return (
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${subscribed ? 'bg-brand-soft text-brand' : 'bg-raised text-soft'}`}>
              {subscribed ? <BellRing className="size-[18px]" aria-hidden="true" /> : permission === 'denied' ? <BellOff className="size-[18px]" aria-hidden="true" /> : <Bell className="size-[18px]" aria-hidden="true" />}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">{subscribed ? 'Device alerts are on' : 'Get alerts on this device'}</p>
              <p className="text-xs text-soft">{description}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {subscribed && (
              <Button size="sm" variant="ghost" loading={testing} onClick={sendTest}>
                Send test
              </Button>
            )}
            <Button size="sm" variant={subscribed ? 'secondary' : 'primary'} loading={busy} disabled={disabled} onClick={() => toggle(!subscribed)}>
              {subscribed ? 'Turn off' : 'Enable alerts'}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <Switch
        checked={subscribed}
        onChange={toggle}
        disabled={disabled}
        label="Send push notifications to this browser / phone"
        description={description}
      />
      {subscribed && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="secondary" loading={testing} onClick={sendTest}>
            Send test push alert
          </Button>
        </div>
      )}
    </div>
  );
}
