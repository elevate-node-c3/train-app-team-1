import { Injectable } from '@nestjs/common';
import { compareSync, hashSync } from 'bcrypt';
import crypto from 'node:crypto';
import { ConfigService } from '@nestjs/config';
@Injectable()
class securityService {
  constructor(private readonly configService: ConfigService) {}

  GlobalCompare(plainText: string, hashText: string) {
    return compareSync(plainText, hashText);
  }

  Globalhash({ plainText }: { plainText: string }) {
    return hashSync(plainText, this.configService.get<string>('HASH_SALT')!);
  }

  Globaldecrypt({ cipherText }: { cipherText: string }) {
    const [hexIv, cipher] = cipherText.split(':');

    const CipherIv = Buffer.from(hexIv, 'hex');
    const Cipher = crypto.createDecipheriv(
      this.configService.get<string>('ENCRYPTION_ALGORITHM')!,
      this.configService.get<string>('ENCRYPTION_KEY')!,
      CipherIv,
    );
    let plainText = Cipher.update(cipher, 'hex', 'utf-8');
    plainText += Cipher.final('hex');
    return plainText;
  }

  Globalencrypt({ plainText }: { plainText: string }) {
    const CipherIv = crypto.randomBytes(
      Number(this.configService.get('CIPHER_IV_SIZE')),
    );
    const Cipher = crypto.createCipheriv(
      this.configService.get<string>('ENCRYPTION_ALGORITHM')!,
      this.configService.get<string>('ENCRYPTION_KEY')!,
      CipherIv,
    );
    let CipherText = Cipher.update(plainText, 'utf-8', 'hex');
    CipherText += Cipher.final('hex');
    return CipherIv + ':' + CipherText;
  }
}

export default securityService;
