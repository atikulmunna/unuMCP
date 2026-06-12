import { Controller, Get, UseGuards } from "@nestjs/common";
import { MetricsService } from "./metrics.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/jwt.strategy";

@Controller("metrics")
@UseGuards(JwtAuthGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** Observability snapshot for the caller's projects (P6-7, §25). */
  @Get()
  collect(@CurrentUser() user: AuthenticatedUser) {
    return this.metrics.collect(user.id);
  }
}
