import { Injectable } from '@nestjs/common';
import { NotificationRepository } from '../persistence/notification.repository.js';

@Injectable()
export class NotificationService {
  constructor(private readonly repository: NotificationRepository) {}

  getInfo(): { service: string; status: string } {
    return {
      service: 'notification',
      status: 'operational',
    };
  }
}
