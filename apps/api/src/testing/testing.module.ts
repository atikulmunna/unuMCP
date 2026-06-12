import { Module } from "@nestjs/common";
import { TestingController } from "./testing.controller";
import { TestingService } from "./testing.service";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";
import { SANDBOX_RUNNER, dockerSandboxRunner } from "./sandbox-runner";

@Module({
  controllers: [TestingController],
  providers: [
    TestingService,
    ProjectOwnershipGuard,
    { provide: SANDBOX_RUNNER, useValue: dockerSandboxRunner },
  ],
})
export class TestingModule {}
