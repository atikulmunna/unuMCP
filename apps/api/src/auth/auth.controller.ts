import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RateLimit } from "../common/rate-limit.decorator";
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from "./schemas";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { CurrentUser } from "./current-user.decorator";
import type { AuthenticatedUser } from "./jwt.strategy";

// Credential endpoints are brute-force targets: keep the bucket tight (§24).
const AUTH_LIMIT = { limit: 10, windowMs: 60_000 };

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  @RateLimit(AUTH_LIMIT)
  register(@Body(new ZodValidationPipe(registerSchema)) body: RegisterInput) {
    return this.auth.register(body.email, body.password, body.name);
  }

  @Post("login")
  @HttpCode(200)
  @RateLimit(AUTH_LIMIT)
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput) {
    return this.auth.login(body.email, body.password);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
