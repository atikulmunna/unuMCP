import { Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/jwt.strategy";
import { RateLimit } from "../common/rate-limit.decorator";
import { SamplesService } from "./samples.service";

@Controller("projects/sample")
@UseGuards(JwtAuthGuard)
export class SamplesController {
  constructor(private readonly samples: SamplesService) {}

  /** Create the Acme Billing sample project in the caller's account. */
  @Post()
  @RateLimit({ limit: 5, windowMs: 60_000 })
  create(@CurrentUser() user: AuthenticatedUser) {
    return this.samples.create(user.id);
  }
}
