import { jsonSchemaToZod } from "@unumcp/schema-gen";
import type { GeneratedFile, McpToolDefinition } from "./types";
import { isReadOnly, pathExpression, toCamel, toolAnnotations, toolTitle, toPascal } from "./helpers";

// One tool's generated sources: its Zod input schema and its registration.

// No exported `z.infer` type alongside the schema: nothing uses it, and Zod
// type inference is the costliest part of typechecking a large server.
export function schemaFile(tool: McpToolDefinition): GeneratedFile {
  const camel = toCamel(tool.name);
  const zod = jsonSchemaToZod(tool.inputSchema);
  const content = `import { z } from "zod";

export const ${camel}Input = ${zod};
`;
  return { path: `src/schemas/${camel}.schema.ts`, content };
}

export function toolFile(tool: McpToolDefinition): GeneratedFile {
  const camel = toCamel(tool.name);
  const pascal = toPascal(tool.name);
  const requestParts: string[] = [];
  for (const location of ["query", "header"] as const) {
    const params = tool.parameters.filter((p) => p.in === location);
    if (params.length === 0) continue;
    const entries = params
      .map((p) => `            ${JSON.stringify(p.name)}: input[${JSON.stringify(p.name)}]`)
      .join(",\n");
    requestParts.push(`${location === "query" ? "query" : "headers"}: {\n${entries},\n          }`);
  }
  if (tool.hasBody) {
    requestParts.push("body: input.body");
    if (tool.bodyMediaType) requestParts.push(`contentType: ${JSON.stringify(tool.bodyMediaType)}`);
  }
  const plannedOptions =
    requestParts.length > 0
      ? `\n        options: {\n          ${requestParts.join(",\n          ")},\n        },`
      : "";
  const meta = { name: tool.name, readOnly: isReadOnly(tool), riskLevel: tool.riskLevel };

  const content = `import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ${camel}Input } from "../schemas/${camel}.schema.js";
import type { ApiClient } from "../client/apiClient.js";
import { runTool, type Policy, type ToolMeta } from "../policy.js";

export const ${camel}Meta: ToolMeta = ${JSON.stringify(meta)};

export function register${pascal}(server: McpServer, client: ApiClient, policy: Policy): void {
  server.registerTool(
    ${JSON.stringify(tool.name)},
    {
      title: ${JSON.stringify(toolTitle(tool.name))},
      description: ${JSON.stringify(tool.description)},
      inputSchema: ${camel}Input.shape,
      annotations: ${JSON.stringify(toolAnnotations(tool))},
    },
    async (args) => {
      const input = ${camel}Input.parse(args);
      const path = ${pathExpression(tool.pathTemplate)};
      return runTool(server, client, policy, ${camel}Meta, {
        method: ${JSON.stringify(tool.method.toUpperCase())},
        path,${plannedOptions}
      });
    },
  );
}
`;
  return { path: `src/tools/${camel}.ts`, content };
}
