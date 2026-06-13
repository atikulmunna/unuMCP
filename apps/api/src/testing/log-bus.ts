import { Injectable } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { Observable } from "rxjs";

export interface SandboxLogEvent {
  /** `log` = a chunk of output, `status` = a state change, `done` = run finished. */
  type: "log" | "status" | "done";
  phase?: "install" | "test";
  chunk?: string;
  status?: string;
}

/**
 * In-process pub/sub for live sandbox output (P4-8, NFR-008). A test run and the
 * SSE stream that watches it are separate requests, so the run publishes chunks
 * here and the `@Sse` endpoint subscribes. This is in-memory and **single-
 * instance** — fine for the MVP, where the HTTP server and the job worker share
 * one Node process (P6-6); a multi-instance deployment would need a shared bus
 * (Redis pub/sub), same trade-off as the in-memory rate limiter.
 */
@Injectable()
export class LogBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many concurrent SSE subscribers are expected; don't warn on >10 listeners.
    this.emitter.setMaxListeners(0);
  }

  publish(projectId: string, event: SandboxLogEvent): void {
    this.emitter.emit(projectId, event);
  }

  /** A cold observable of this project's events; unsubscribing detaches the listener. */
  subscribe(projectId: string): Observable<SandboxLogEvent> {
    return new Observable<SandboxLogEvent>((subscriber) => {
      const handler = (event: SandboxLogEvent) => subscriber.next(event);
      this.emitter.on(projectId, handler);
      return () => this.emitter.off(projectId, handler);
    });
  }
}
