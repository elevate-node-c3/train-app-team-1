import { Injectable } from '@nestjs/common';

@Injectable()
export class BookingsService {
  getHello(): string {
    return 'Hello World!';
  }
}
