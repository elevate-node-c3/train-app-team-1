import { Controller, Logger, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { HEALTH_SERVICE_NAME } from '@app/contracts';
import { HealthService } from './health.service.js';
import { GrpcCorrelationInterceptor } from '../correlation/grpc-correlation.interceptor.js';

@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class HealthGrpcController {
  private readonly logger = new Logger(HealthGrpcController.name);

  constructor(private readonly healthService: HealthService) {}

  @GrpcMethod(HEALTH_SERVICE_NAME, 'Check')
  async check(data: { service: string }): Promise<{
    status: number;
    service: string;
    message: string;
    details: Record<string, string>;
  }> {
    this.logger.log(
      `Received health check for service: ${data?.service || process.env.APP || 'unknown'}`,
    );
    try {
      const report = await this.healthService.checkReadiness(data.service);
      const detailsMap: Record<string, string> = {};
      for (const [key, value] of Object.entries(report.dependencies)) {
        detailsMap[key] = value.status;
      }

      // Proto enum: 1 = SERVING, 2 = NOT_SERVING, 4 = DEGRADED
      let statusCode = 1;
      if (report.status === 'not_ready') {
        statusCode = 2;
      } else if (report.status === 'degraded') {
        statusCode = 4;
      }

      return {
        status: statusCode,
        service: report.service,
        message: report.status,
        details: detailsMap,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        status: 2, // NOT_SERVING
        service: data?.service || process.env.APP || 'unknown',
        message: errMsg,
        details: { error: errMsg },
      };
    }
  }
}
