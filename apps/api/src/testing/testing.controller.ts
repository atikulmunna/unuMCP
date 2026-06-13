import {
  Controller,
  Get,
  HttpCode,
  type MessageEvent,
  Param,
  Post,
  Sse,
  UseGuards,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { map, takeWhile } from "rxjs/operators";
import { TestingService } from "./testing.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";
import { JobsService } from "../jobs/jobs.service";

@Controller("projects/:projectId/test")
@UseGuards(JwtAuthGuard, ProjectOwnershipGuard)
export class TestingController {
  constructor(
    private readonly testing: TestingService,
    private readonly jobs: JobsService,
  ) {}

  @Post()
  @HttpCode(200)
  // Inline (returns results) or enqueued (returns a queued handle) per P6-6.
  run(@Param("projectId") projectId: string) {
    return this.jobs.enqueueTest(projectId);
  }

  @Get()
  results(@Param("projectId") projectId: string) {
    return this.testing.getResults(projectId);
  }

  /**
   * Server-Sent Events stream of live sandbox output + status (P4-8, NFR-008).
   * Consumed via `fetch` (so the Bearer token rides the Authorization header —
   * native EventSource can't send headers). Completes after the `done` event so
   * the client closes cleanly.
   */
  @Sse("stream")
  stream(@Param("projectId") projectId: string): Observable<MessageEvent> {
    return this.testing.watch(projectId).pipe(
      takeWhile((event) => event.type !== "done", true),
      map((data) => ({ data })),
    );
  }

  @Post("cancel")
  @HttpCode(200)
  cancel(@Param("projectId") projectId: string) {
    return this.testing.cancel(projectId);
  }
}
