import { randomUUID } from 'node:crypto';
import { isolatedHoldEndpoints, rabbitManagement } from './hold-fixture.js';

/** Own a fresh local namespace, including any fixed production topology names. */
export async function ephemeralRabbitVhost(label: string): Promise<{
  name: string;
  rabbit: string;
  close: () => Promise<void>;
}> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(label))
    throw new Error('Invalid test RabbitMQ namespace label.');
  const url = new URL(isolatedHoldEndpoints().rabbit);
  const name = `test.integration.${label}.${randomUUID()}`;
  const path = encodeURIComponent(name);
  const user = encodeURIComponent(decodeURIComponent(url.username));
  await rabbitManagement(`vhosts/${path}`, { method: 'PUT' });
  try {
    await rabbitManagement(`permissions/${path}/${user}`, {
      method: 'PUT',
      body: { configure: '.*', write: '.*', read: '.*' },
    });
  } catch (error) {
    await rabbitManagement(`vhosts/${path}`, {
      method: 'DELETE',
      allowMissing: true,
    });
    throw error;
  }
  url.pathname = `/${path}`;
  let closed = false;
  return {
    name,
    rabbit: url.href,
    close: async () => {
      if (closed) return;
      // Only this exact generated name is ever deleted, never the root vhost or
      // a pre-existing queue that happens to use a production topology name.
      await rabbitManagement(`vhosts/${path}`, {
        method: 'DELETE',
        allowMissing: true,
      });
      closed = true;
    },
  };
}
