import { Controller, Get } from '@nestjs/common';
import { NotificationService } from '../domain/notification.service.js';

@Controller('notification')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  getInfo(): { service: string; status: string } {
    return this.notificationService.getInfo();
  }
}
