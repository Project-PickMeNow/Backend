import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// @Global — 어느 모듈에서든 주입 없이 PrismaService 사용 가능
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
