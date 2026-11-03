# Authorization matrix

This document reflects the routes mounted by `src/app.ts` and the role middleware in the current route modules. Authentication resolves the user by the JWT subject and checks that the database account is `ACTIVE`. The role stored on that user row is authoritative; a role claim in a JWT or body does not grant permissions. Missing/invalid credentials return 401, inactive accounts return 403, and a valid account without route permission returns 403.

## Route permissions

| Resource / operation | Public | CUSTOMER | DRIVER | DISPATCHER | ADMIN | SUPER_ADMIN |
| --- | --- | --- | --- | --- | --- | --- |
| Root, health liveness/readiness | Yes | Yes | Yes | Yes | Yes | Yes |
| Health metrics | Metrics bearer token | Metrics bearer token | Metrics bearer token | Metrics bearer token | Metrics bearer token | Metrics bearer token |
| API docs | Development by default; production disabled or token-protected | Same | Same | Same | Same | Same |
| Register, login, refresh, logout, email verification, password recovery | Yes | Yes | Yes | Yes | Yes | Yes |
| `GET /auth/me` | No | Own account | Own account | Own account | Own account | Own account |
| Public delivery tracking by tracking code | Yes | Yes | Yes | Yes | Yes | Yes |
| Create delivery | No | Own customer account | No | No | Any existing customer | Any existing customer |
| List own deliveries | No | Own deliveries | No | No | No | No |
| Search deliveries and delivery statistics | No | No | No | All | All | All |
| List assigned deliveries | No | No | Own assignments | No | No | No |
| Read delivery detail / GPS / GPS history | No | Own customer deliveries | Own assigned deliveries | All | All | All |
| Assign or reassign delivery driver | No | No | No | All eligible deliveries | All eligible deliveries | All eligible deliveries |
| `GET /api/v1/dispatch/deliveries/{id}/recommendations` | No | No | No | Eligible delivery recommendations | Eligible delivery recommendations | Eligible delivery recommendations |
| List driver vehicles, shifts, and qualifications | No | No | No | Read all | Read all | Read all |
| Manage vehicles, driver shifts, availability, and qualifications | No | No | No | No | All | All |
| Verify driver qualifications | No | No | No | No | All | All |
| Update delivery transport requirements | No | No | No | All | All | All |
| Update delivery status | No | Own pending delivery may be cancelled | Own assigned delivery, subject to lifecycle | All | All | All |
| Submit driver GPS location | No | No | Own assigned active delivery | No | No | No |
| Create driver or update driver/profile status | No | No | No | No | All drivers | All drivers |
| Read/list driver profiles and statistics | No | No | No | All | All | All |
| Create customer or update customer/profile status | No | No | No | No | All customers | All customers |
| Read/list customer profiles and statistics | No | No | No | All | All | All |
| Read/mark notifications | No | Own notifications | Own notifications | Own notifications | Own notifications | Own notifications |
| Read audit logs | No | No | No | No | All audit records | All audit records |
| Mutate or delete audit logs | No | No | No | No | No | No |

“All” is restricted to the module's resource type and implemented filters. Driver assignment additionally requires an active user with the DRIVER role. Driver GPS writes require that the caller is the currently assigned driver and delivery status is `PICKED_UP` or `IN_TRANSIT`. Delivery status changes also enforce lifecycle transitions and customer/driver ownership in the service transaction.

Dispatch recommendations are advisory and limited to ADMIN, SUPER_ADMIN, and DISPATCHER. They can only be requested for an existing PENDING or ASSIGNED delivery with pickup coordinates. Candidates need an active DRIVER account, AVAILABLE workforce state, a current active shift, a current active vehicle meeting delivery capacity/type/refrigeration needs, verified and unexpired required qualifications, fresh GPS, and workload under the configured cap. Missing vehicle, shift, qualification, or GPS data excludes a candidate. The API returns driver IDs and operational score details only; it does not return profile, contact, address, or coordinate values. Assignment revalidates account, availability, workload, shift, qualification, and vehicle eligibility under a shared per-driver lock and does not rely on earlier recommendation results. If pickup coordinates are missing, recommendations are unavailable and a direct staff assignment does not require GPS freshness.

## Resource ownership and IDOR controls

- Customer list operations bind the customer ID from the authenticated user, never a query/body-supplied owner ID.
- Delivery detail and nested GPS reads constrain the database lookup by delivery ID and either staff role, customer ID, or assigned driver ID. Status and GPS writes also verify caller ownership before applying the operation. A foreign or nonexistent delivery returns 404 to avoid an existence oracle.
- Delivery creation ignores customer ownership claims for customers by requiring their authenticated ID; a mismatched `customerId` is rejected. Staff creation requires an existing customer ID.
- Driver and customer profile paths are available only to staff roles. The services constrain IDs to the expected role, so a driver ID cannot be used to read or update a customer as though they were a driver, and vice versa.
- Notifications are always queried and updated with both notification ID and the authenticated user's ID. A notification belonging to another account returns 404.
- Audit records are readable only by ADMIN/SUPER_ADMIN. The API has no individual audit read, create, update, or delete endpoint.
- JWT role claims are not authorization inputs. Registration does not accept a role and server-side account creation assigns the customer role.

## Role lifecycle and limits

There is no user-role change endpoint in the current API. Administrators can change customer and driver account status; drivers with active deliveries cannot be deactivated. Authentication rejects non-active accounts on every protected request. User role changes made directly in the database take effect on the next request because roles are reloaded from PostgreSQL.

This matrix describes application-level controls. It is not a database row-level security policy and cannot constrain a privileged database operator. Delivery detail responses include operational/customer data for authorized owners and staff; the public tracking endpoint has a separate privacy-limited response. Add new routes to both this matrix and OpenAPI when introducing functionality.
