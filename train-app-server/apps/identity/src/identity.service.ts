import { ConflictException, Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { User } from './entity/user.entity.js';
import {
  VerificationCode,
  VerificationPurpose,
} from './entity/verification-code.entity.js';
import { OutboxEvent } from './entity/outbox-event.entity.js';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { DataSource } from 'typeorm';
import { SignupDto } from './dto/signup.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { ResendVerificationCodeDto } from './dto/resend-verification-code.dto.js';
import { RedisService } from './redis/redis.service.js';

@Injectable()
export class IdentityService {
  constructor(
    private readonly dataSource: DataSource,

    private readonly redisService: RedisService,
  ) {}

  getHello(): string {
    return 'Hello World!';
  }

  // إخفاء جزء من الإيميل لحماية خصوصية المستخدم
  private maskEmail(email: string): string {
    const [localPart, domain] = email.split('@');

    // إظهار أول حرفين وإخفاء الباقي
    const visiblePart = localPart.slice(0, 2);
    const maskedPart = '*'.repeat(
      Math.max(localPart.length - visiblePart.length, 1),
    );

    return `${visiblePart}${maskedPart}@${domain}`;
  }

  async signup(dto: SignupDto) {
    

    const email = dto.email.trim().toLowerCase();

    const waitSeconds = await this.redisService.canResend(email);

    if (waitSeconds > 0) {
      throw new ConflictException(
        `Please wait ${waitSeconds} seconds before requesting another code.`,
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    const codeHash = await bcrypt.hash(code, 10);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const result = await this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const verificationCodeRepo = manager.getRepository(VerificationCode);
      const outboxEventRepo = manager.getRepository(OutboxEvent);

      const existingUser = await userRepo.findOne({
        where: { email },
      });

      if (existingUser) {
        if (existingUser.emailVerifiedAt) {
          throw new ConflictException(
            'This email is already registered. Please sign in or recover your password.',
          );
        }
      }

      let user: User;

      if (!existingUser) {
        user = userRepo.create({
          email,
          passwordHash,
          language: dto.language,
          emailVerifiedAt: null,
        });
      } else {
        existingUser.passwordHash = passwordHash;
        existingUser.language = dto.language;

        user = existingUser;
      }
      user = await userRepo.save(user);

      await verificationCodeRepo.update(
        {
          userId: user.id,
          purpose: VerificationPurpose.EMAIL_VERIFICATION,
          usedAt: IsNull(),
          invalidatedAt: IsNull(),
        },
        {
          invalidatedAt: new Date(),
        },
      );

      const verificationCode = verificationCodeRepo.create({
        userId: user.id,
        purpose: VerificationPurpose.EMAIL_VERIFICATION,
        codeHash,
        expiresAt,
        usedAt: null,
        invalidatedAt: null,
      });

      await verificationCodeRepo.save(verificationCode);

      await outboxEventRepo.save(
        outboxEventRepo.create({
          eventType: 'ACCOUNT_REGISTERED',
          payload: {
            userId: user.id,
            email: user.email,
            language: user.language,
          },
        }),
      );

      await outboxEventRepo.save(
        outboxEventRepo.create({
          eventType: 'VERIFICATION_CODE_ISSUED',
          payload: {
            userId: user.id,
            email: user.email,
            language: user.language,
            code,
          },
        }),
      );

      return this.maskEmail(user.email);
    });

    await this.redisService.recordResend(email);
    return {
      message: 'Verification code issued successfully',
      destination: result,
      resendAvailableInSeconds: 120,
      // code,
    };
  }

  async verifyEmail(dto: VerifyEmailDto) {
    const email = dto.email.trim().toLowerCase();

    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const verificationCodeRepo = manager.getRepository(VerificationCode);

      const user = await userRepo.findOne({
        where: { email },
      });

      if (!user) {
        throw new ConflictException('Verification failed. Request a new code.');
      }

      if (user.emailVerifiedAt) {
        throw new ConflictException('Email is already verified.');
      }

      const verificationCode = await verificationCodeRepo.findOne({
        where: {
          userId: user.id,
          purpose: VerificationPurpose.EMAIL_VERIFICATION,
          usedAt: IsNull(),
          invalidatedAt: IsNull(),
        },
        order: { createdAt: 'DESC' },
      });

      if (
        !verificationCode ||
        verificationCode.expiresAt.getTime() <= Date.now()
      ) {
        throw new ConflictException(
          'Verification code expired. Request a new code.',
        );
      }

      const isCodeValid = await bcrypt.compare(
        dto.code,
        verificationCode.codeHash,
      );

      if (!isCodeValid) {
        throw new ConflictException('Invalid verification code.');
      }

      user.emailVerifiedAt = new Date();
      verificationCode.usedAt = new Date();

      await userRepo.save(user);
      await verificationCodeRepo.save(verificationCode);

      const outboxEventRepo = manager.getRepository(OutboxEvent);

      await outboxEventRepo.save(
        outboxEventRepo.create({
          eventType: 'EMAIL_ADDRESS_VERIFIED',
          payload: {
            userId: user.id,
            email: user.email,
          },
        }),
      );

      return {
        message: 'Email verified successfully',
      };
    });
  }

  async resendVerificationCode(dto: ResendVerificationCodeDto) {
    const email = dto.email.trim().toLowerCase();

    const waitSeconds = await this.redisService.canResend(email);

    if (waitSeconds > 0) {
      throw new ConflictException(
        `Please wait ${waitSeconds} seconds before requesting another code.`,
      );
    }

    const user = await this.dataSource.getRepository(User).findOne({
      where: { email },
    });

    if (!user) {
      throw new ConflictException('Verification request failed.');
    }

    if (user.emailVerifiedAt) {
      throw new ConflictException('Email is already verified.');
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    const codeHash = await bcrypt.hash(code, 10);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await this.dataSource.transaction(async (manager) => {
      const verificationCodeRepo = manager.getRepository(VerificationCode);

      await verificationCodeRepo.update(
        {
          userId: user.id,
          purpose: VerificationPurpose.EMAIL_VERIFICATION,
          usedAt: IsNull(),
          invalidatedAt: IsNull(),
        },
        {
          invalidatedAt: new Date(),
        },
      );

      const verificationCode = verificationCodeRepo.create({
        userId: user.id,
        purpose: VerificationPurpose.EMAIL_VERIFICATION,
        codeHash,
        expiresAt,
        usedAt: null,
        invalidatedAt: null,
      });

      await verificationCodeRepo.save(verificationCode);

      const outboxEventRepo = manager.getRepository(OutboxEvent);

      await outboxEventRepo.save(
        outboxEventRepo.create({
          eventType: 'VERIFICATION_CODE_ISSUED',
          payload: {
            userId: user.id,
            email: user.email,
            language: user.language,
            code,
          },
        }),
      );
    });

    await this.redisService.recordResend(email);

    return {
      message: 'Verification code issued successfully',
      destination: this.maskEmail(user.email),
      resendAvailableInSeconds: 120,
    };
  }
}
