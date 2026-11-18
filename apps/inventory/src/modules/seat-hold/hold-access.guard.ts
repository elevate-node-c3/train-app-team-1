import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Metadata, status } from '@grpc/grpc-js';
import { ErrorCode } from '@app/contracts';
import { matchesServiceCredential } from '@app/common/grpc/service-credential.js';
import {
  DataSourceInitializer,
  MigrationRunnerService,
  SchemaReadinessGate,
} from '@app/common';

@Injectable()
export class HoldServiceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const metadata = context.switchToRpc().getContext<Metadata>();
    const values = metadata?.get?.('x-booking-inventory-key') ?? [];
    if (
      values.length !== 1 ||
      !matchesServiceCredential(
        values[0],
        process.env.BOOKING_INVENTORY_SERVICE_KEY,
      )
    ) {
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        details: JSON.stringify({ code: ErrorCode.FORBIDDEN }),
      });
    }
    return true;
  }
}

@Injectable()
export class HoldCreationGuard implements CanActivate {
  constructor(
    @Inject(DataSourceInitializer)
    private readonly initializer: DataSourceInitializer,
    @Inject(SchemaReadinessGate) private readonly schema: SchemaReadinessGate,
    @Inject(MigrationRunnerService)
    private readonly migrations: MigrationRunnerService,
  ) {}

  async canActivate(): Promise<boolean> {
    const unavailable = () =>
      new RpcException({
        code: status.UNAVAILABLE,
        details: JSON.stringify({ code: ErrorCode.SERVICE_UNAVAILABLE }),
      });
    // Rollback disables new ownership, not release, expiry, or durable publication.
    if (process.env.HOLD_CREATION_ENABLED !== 'true') throw unavailable();
    await this.schema.whenReady;
    if (!this.migrations.hasCompleted) throw unavailable();

    try {
      const source = await this.initializer.ensureInitialized();
      // Anonymous live legacy rows cannot participate in National-ID exclusion.
      const [readiness]: { needsBackfill: boolean }[] = await source.query(
        `SELECT EXISTS (
           SELECT 1 FROM seat_occupation
           WHERE released_at IS NULL
             AND (state = 'sold' OR (state = 'held' AND hold_expires_at > clock_timestamp()))
             AND (owner_id IS NULL OR passenger_ref IS NULL OR passenger_token IS NULL OR passenger_key_version IS NULL)
         ) AS "needsBackfill"`,
      );
      if (readiness?.needsBackfill !== false) throw unavailable();
      return true;
    } catch {
      // Never expose row identities or driver diagnostics in readiness refusals.
      throw unavailable();
    }
  }
}
