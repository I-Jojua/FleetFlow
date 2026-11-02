# API response consistency review

This review describes the current controller behavior. Existing response bodies have not been rewritten, to avoid breaking clients.

## Shared conventions

- Most endpoints return JSON with `success` and endpoint data in `data`.
- The global error middleware returns `{ success: false, code, message }` and never returns an internal stack trace.
- Pagination metadata is named `pagination` and includes `total`, `page`, `limit`, `totalPages`, `hasNextPage`, and `hasPreviousPage`.
- OpenAPI documents each endpoint's actual response shape, including the exceptions below.

## Existing differences

| Area | Current difference |
| --- | --- |
| Success envelopes | Some collection/statistics endpoints omit `message`; most mutation/detail endpoints include it. Logout returns `{ success, message }` without `data`. |
| Pagination | Delivery, driver, customer, and notification lists return `pagination` beside `data`. Location history nests both `locations` and `pagination` inside `data`. |
| Authentication errors | `AuthError` responses contain `success` and `message`, without the global `code` property. Some auth validation responses return only a message. |
| Validation errors | Auth registration/login and delivery validation use path/message arrays; driver/customer validation uses Zod's flattened `{ formErrors, fieldErrors }`; notification validation uses path/message arrays. |
| Local not-found/forbidden responses | Some controllers return a message without a `code`; central middleware errors include a `code`. |
| Delivery assignment | A customer-created delivery has `customerId` inferred from the authenticated user. Staff creation requires the body field `customerId`. |

## Safe follow-up

The response differences are documented in OpenAPI and this review. A future versioned API contract can standardize error and pagination envelopes; changing them in-place would risk breaking existing clients, so this P3 work leaves those payloads intact.
