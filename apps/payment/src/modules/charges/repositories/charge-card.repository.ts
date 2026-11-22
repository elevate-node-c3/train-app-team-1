import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SavedCardEntity } from '../../cards/entities/saved-card.entity.js';
import type { ChargeCard } from '../types/charge.types.js';

@Injectable()
export class ChargeCardRepository {
  constructor(
    @InjectRepository(SavedCardEntity)
    private readonly cards: Repository<SavedCardEntity>,
  ) {}

  async findOwned(
    cardId: string,
    accountId: string,
  ): Promise<ChargeCard | undefined> {
    const card = await this.cards.findOne({
      where: { id: cardId, accountId },
      select: {
        stripePaymentMethodId: true,
        brand: true,
        last4: true,
        expMonth: true,
        expYear: true,
        status: true,
      },
    });
    return card ?? undefined;
  }

  async markUsed(cardId: string, accountId: string): Promise<void> {
    await this.cards.update(
      { id: cardId, accountId, status: 'active' },
      { lastUsedAt: new Date() },
    );
  }

  async findCustomerIdByPaymentMethodId(
    paymentMethodId: string,
  ): Promise<string | undefined> {
    const card = await this.cards.findOne({
      where: { stripePaymentMethodId: paymentMethodId },
      select: { stripeCustomerId: true },
    });
    return card?.stripeCustomerId;
  }
}
