import { Module } from "@nestjs/common";
import { TestingController } from "./testing.controller";
import { TestingService } from "./testing.service";
import { LogBus } from "./log-bus";
import { ProjectOwnershipGuard } from "../common/project-ownership.guard";
import { SANDBOX_RUNNER, dockerSandboxRunner } from "./sandbox-runner";

@Module({
  controllers: [TestingController],
  providers: [
    TestingService,
    LogBus,
    ProjectOwnershipGuard,
    { provide: SANDBOX_RUNNER, useValue: dockerSandboxRunner },
  ],
})
export class TestingModule {}
