import { CreateProcessedEventEmailDelivery1761314500000 } from './1761314500000-create-processed-event-email-delivery.js';

/**
 * Explicit ordering. TypeORM also sorts by the class-name timestamp, but an
 * explicit array is what the migration test inspects and what a reviewer reads.
 */
export const migrations = [CreateProcessedEventEmailDelivery1761314500000];

export { CreateProcessedEventEmailDelivery1761314500000 };
