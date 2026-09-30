import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { JwtStrategy } from "./jwt.strategy";
import { jwtSecretFromEnv } from "./jwt.config";

@Module({
  imports: [
    PassportModule,
    // Resolved at boot (not import time) so a missing/weak secret fails app startup.
    JwtModule.registerAsync({
      useFactory: () => ({ secret: jwtSecretFromEnv(), signOptions: { expiresIn: "7d" } }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
