// Recorded by scripts/record-sample.mts from a real usability check with
// Claude on the sample spec. Regenerate it rather than editing it.
export const ACME_BILLING_RECORDED = {
  "model": "claude-haiku-4-5-20251001",
  "recordedOn": "2026-11-01",
  "note": null,
  "inputTokens": 21975,
  "outputTokens": 1207,
  "estimatedCostUsd": "0.028",
  "taskCount": 9,
  "answeredCount": 9,
  "baselineCorrect": 8,
  "fixedCorrect": 9,
  "tasks": [
    {
      "toolName": "create_customer",
      "prompt": "Create a new customer named Alice Smith with email alice.smith@example.com.",
      "expectedArgs": {
        "body": {
          "name": "Alice Smith",
          "email": "alice.smith@example.com"
        }
      },
      "candidateNames": [
        "create_customer",
        "fetch_invoices",
        "get_customer",
        "get_invoice",
        "get_invoices",
        "get_invoices_2",
        "list_customers",
        "list_payments",
        "search_invoices"
      ],
      "chosenTool": "create_customer",
      "chosenArgs": {
        "body": {
          "name": "Alice Smith",
          "email": "alice.smith@example.com"
        }
      },
      "outcome": "correct",
      "reason": null
    },
    {
      "toolName": "fetch_invoices",
      "prompt": "Show me all draft invoices.",
      "expectedArgs": {},
      "candidateNames": [
        "create_customer",
        "fetch_invoices",
        "get_customer",
        "get_invoice",
        "get_invoices",
        "get_invoices_2",
        "list_customers",
        "list_payments",
        "search_invoices"
      ],
      "chosenTool": "get_invoices",
      "chosenArgs": {
        "status": "draft"
      },
      "outcome": "wrong_tool",
      "reason": "Picked get_invoices instead of fetch_invoices."
    },
    {
      "toolName": "get_customer",
      "prompt": "Get the customer details for cus_123.",
      "expectedArgs": {
        "customerId": "cus_123"
      },
      "candidateNames": [
        "create_customer",
        "fetch_invoices",
        "get_customer",
        "get_invoice",
        "get_invoices",
        "get_invoices_2",
        "list_customers",
        "list_payments",
        "search_invoices"
      ],
      "chosenTool": "get_customer",
      "chosenArgs": {
        "customerId": "cus_123"
      },
      "outcome": "correct",
      "reason": null
    },
    {
      "toolName": "get_invoice",
      "prompt": "Show me the details of invoice in_456.",
      "expectedArgs": {
        "invoiceId": "in_456"
      },
      "candidateNames": [
        "create_customer",
        "fetch_invoices",
        "get_customer",
        "get_invoice",
        "get_invoices",
        "get_invoices_2",
        "list_customers",
        "list_payments",
        "search_invoices"
      ],
      "chosenTool": "get_invoice",
      "chosenArgs": {
        "invoiceId": "in_456"
      },
      "outcome": "correct",
      "reason": null
    },
    {
      "toolName": "get_invoices",
      "prompt": "List all paid invoices for customer cus_789.",
      "expectedArgs": {
        "status": "paid",
        "customerId": "cus_789"
      },
      "candidateNames": [
        "create_customer",
        "fetch_invoices",
        "get_customer",
        "get_invoice",
        "get_invoices",
        "get_invoices_2",
        "list_customers",
        "list_payments",
        "search_invoices"
      ],
      "chosenTool": "get_invoices",
      "chosenArgs": {
        "status": "paid",
        "customerId": "cus_789"
      },
      "outcome": "correct",
      "reason": null
    },
    {
      "toolName": "get_invoices_2",
      "prompt": "Show me all invoices for customer cus_999.",
      "expectedArgs": {
        "customerId": "cus_999"
      },
      "candidateNames": [
        "create_customer",
        "fetch_invoices",
        "get_customer",
        "get_invoice",
        "get_invoices",
        "get_invoices_2",
        "list_customers",
        "list_payments",
        "search_invoices"
      ],
      "chosenTool": "get_invoices_2",
      "chosenArgs": {
        "customerId": "cus_999"
      },
      "outcome": "correct",
      "reason": null
    },
    {
      "toolName": "list_customers",
      "prompt": "Find the customer with email address john@example.com.",
      "expectedArgs": {
        "email": "john@example.com"
      },
      "candidateNames": [
        "create_customer",
        "fetch_invoices",
        "get_customer",
        "get_invoice",
        "get_invoices",
        "get_invoices_2",
        "list_customers",
        "list_payments",
        "search_invoices"
      ],
      "chosenTool": "list_customers",
      "chosenArgs": {
        "email": "john@example.com"
      },
      "outcome": "correct",
      "reason": null
    },
    {
      "toolName": "list_payments",
      "prompt": "List all payments made for invoice in_789.",
      "expectedArgs": {
        "invoiceId": "in_789"
      },
      "candidateNames": [
        "create_customer",
        "fetch_invoices",
        "get_customer",
        "get_invoice",
        "get_invoices",
        "get_invoices_2",
        "list_customers",
        "list_payments",
        "search_invoices"
      ],
      "chosenTool": "list_payments",
      "chosenArgs": {
        "invoiceId": "in_789"
      },
      "outcome": "correct",
      "reason": null
    },
    {
      "toolName": "search_invoices",
      "prompt": "Search for invoices containing the word 'consulting' in the line items or notes.",
      "expectedArgs": {
        "q": "consulting"
      },
      "candidateNames": [
        "create_customer",
        "fetch_invoices",
        "get_customer",
        "get_invoice",
        "get_invoices",
        "get_invoices_2",
        "list_customers",
        "list_payments",
        "search_invoices"
      ],
      "chosenTool": "search_invoices",
      "chosenArgs": {
        "q": "consulting"
      },
      "outcome": "correct",
      "reason": null
    }
  ],
  "fixes": [
    {
      "toolName": "fetch_invoices",
      "afterName": null,
      "afterDescription": "List draft invoices only. Use this to retrieve invoices in draft status; use get_invoices with status filter for other statuses or to filter by customer.",
      "missesFixed": 1,
      "pairedWith": [
        "get_invoices"
      ]
    },
    {
      "toolName": "get_invoices",
      "afterName": null,
      "afterDescription": "List invoices with optional filtering by status (draft, open, paid, void) or customer ID. Use this for flexible invoice queries; use fetch_invoices to list only draft invoices.",
      "missesFixed": 0,
      "pairedWith": [
        "fetch_invoices"
      ]
    }
  ]
};
