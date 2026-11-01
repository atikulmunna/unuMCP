// The OpenAPI spec behind the built-in sample project: a small, fictional
// billing API with what real APIs often have: look-alike routes (all invoices
// with a customer filter, and one customer's invoices) that, like many specs,
// lack operationIds, and actions whose summaries undersell what they do
// (voiding an invoice, refunding a payment).

const ok = (description: string, schema?: object) =>
  schema
    ? { description, content: { "application/json": { schema } } }
    : { description };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const list = (name: string) => ({ type: "array", items: ref(name) });
const path = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string" },
});
const query = (name: string, description: string, schema: object = { type: "string" }) => ({
  name,
  in: "query",
  description,
  schema,
});
const body = (schema: object) => ({ required: true, content: { "application/json": { schema } } });

export const ACME_BILLING_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "Acme Billing API",
    version: "1.0.0",
    description: "Customers, invoices and payments for a fictional SaaS company.",
  },
  servers: [{ url: "https://api.acme-billing.example.com/v1" }],
  security: [{ bearerAuth: [] }],
  paths: {
    "/customers": {
      get: {
        operationId: "listCustomers",
        summary: "List customers",
        parameters: [query("email", "Only the customer with this email address.")],
        responses: { "200": ok("Customers", list("Customer")) },
      },
      post: {
        operationId: "createCustomer",
        summary: "Create a customer",
        requestBody: body({
          type: "object",
          required: ["email"],
          properties: { email: { type: "string" }, name: { type: "string" } },
        }),
        responses: { "201": ok("The new customer", ref("Customer")) },
      },
    },
    "/customers/{customerId}": {
      get: {
        operationId: "getCustomer",
        summary: "Get a customer",
        parameters: [path("customerId", "The customer's id, e.g. cus_123.")],
        responses: { "200": ok("The customer", ref("Customer")) },
      },
      delete: {
        operationId: "deleteCustomer",
        summary: "Delete a customer",
        parameters: [path("customerId", "The customer's id.")],
        responses: { "204": ok("Deleted") },
      },
    },
    "/customers/{customerId}/invoices": {
      get: {
        summary: "List invoices",
        parameters: [path("customerId", "The customer's id.")],
        responses: { "200": ok("Invoices", list("Invoice")) },
      },
    },
    "/invoices": {
      get: {
        summary: "List invoices",
        parameters: [
          query("status", "Filter by status.", { type: "string", enum: ["draft", "open", "paid", "void"] }),
          query("customerId", "Filter by customer."),
        ],
        responses: { "200": ok("Invoices", list("Invoice")) },
      },
      post: {
        operationId: "createInvoice",
        summary: "Create an invoice",
        requestBody: body({
          type: "object",
          required: ["customerId", "amount", "currency"],
          properties: {
            customerId: { type: "string" },
            amount: { type: "integer", description: "In cents." },
            currency: { type: "string", enum: ["usd", "eur", "gbp"] },
          },
        }),
        responses: { "201": ok("The new invoice", ref("Invoice")) },
      },
    },
    // Overlaps GET /invoices?status=draft, as legacy routes often do.
    "/invoices/drafts": {
      get: {
        operationId: "fetchInvoices",
        summary: "List invoices",
        responses: { "200": ok("Invoices", list("Invoice")) },
      },
    },
    "/invoices/search": {
      get: {
        operationId: "searchInvoices",
        summary: "Search invoices",
        parameters: [query("q", "Text to look for in invoice line items and notes.")],
        responses: { "200": ok("Matching invoices", list("Invoice")) },
      },
    },
    "/invoices/{invoiceId}": {
      get: {
        operationId: "getInvoice",
        summary: "Get an invoice",
        parameters: [path("invoiceId", "The invoice's id, e.g. in_123.")],
        responses: { "200": ok("The invoice", ref("Invoice")) },
      },
    },
    "/invoices/{invoiceId}/void": {
      post: {
        operationId: "voidInvoice",
        summary: "Update an invoice",
        parameters: [path("invoiceId", "The invoice's id.")],
        responses: { "200": ok("The invoice", ref("Invoice")) },
      },
    },
    "/payments": {
      get: {
        operationId: "listPayments",
        summary: "List payments",
        parameters: [query("invoiceId", "Only payments for this invoice.")],
        responses: { "200": ok("Payments", list("Payment")) },
      },
    },
    "/payments/{paymentId}/refund": {
      post: {
        operationId: "refundPayment",
        summary: "Refund a payment",
        parameters: [path("paymentId", "The payment's id, e.g. py_123.")],
        requestBody: body({
          type: "object",
          properties: { amount: { type: "integer", description: "In cents; the full payment if left out." } },
        }),
        responses: { "200": ok("The refund", ref("Payment")) },
      },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: {
      Customer: {
        type: "object",
        properties: { id: { type: "string" }, email: { type: "string" }, name: { type: "string" } },
      },
      Invoice: {
        type: "object",
        properties: {
          id: { type: "string" },
          customerId: { type: "string" },
          status: { type: "string", enum: ["draft", "open", "paid", "void"] },
          amount: { type: "integer" },
          currency: { type: "string" },
        },
      },
      Payment: {
        type: "object",
        properties: { id: { type: "string" }, invoiceId: { type: "string" }, amount: { type: "integer" } },
      },
    },
  },
} as const;
