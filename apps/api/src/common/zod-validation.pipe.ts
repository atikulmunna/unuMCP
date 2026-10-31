import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { z, type ZodType } from "zod";

/** Validates a request payload against a Zod schema, returning typed data. */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(z.flattenError(result.error));
    }
    return result.data;
  }
}
