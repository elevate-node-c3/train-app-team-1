import { Module } from '@nestjs/common';
import {
  ClientsModule,
  Transport,
  type ClientGrpc,
} from '@nestjs/microservices';
import {
  PAYMENT_PACKAGE_NAME,
  PAYMENT_SERVICE_NAME,
  getPaymentProtoPath,
} from '@app/contracts';
import { downstreamGrpcUrlsFromEnv } from '../../config/grpc-settings.js';
import { SavedCardsController } from './saved-cards.controller.js';
import { SavedCardsGrpcClientService } from './saved-cards.grpc.client.js';
import { SavedCardsService } from './saved-cards.service.js';
import {
  PAYMENT_GRPC_CLIENT,
  type PaymentGrpcClient,
} from './saved-cards.types.js';

const PAYMENT_GRPC = 'PAYMENT_GRPC';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: PAYMENT_GRPC,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: PAYMENT_PACKAGE_NAME,
            protoPath: getPaymentProtoPath(),
            url: downstreamGrpcUrlsFromEnv().payment,
            loader: { enums: String, arrays: true },
          },
        }),
      },
    ]),
  ],
  controllers: [SavedCardsController],
  providers: [
    SavedCardsService,
    SavedCardsGrpcClientService,
    {
      provide: PAYMENT_GRPC_CLIENT,
      inject: [PAYMENT_GRPC],
      useFactory: (client: ClientGrpc) =>
        client.getService<PaymentGrpcClient>(PAYMENT_SERVICE_NAME),
    },
  ],
  exports: [SavedCardsService],
})
export class SavedCardsModule {}
