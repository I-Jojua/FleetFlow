import type { UserRole } from "../../generated/prisma/client.js";

/** Operational roles allowed to inspect or administer cross-account resources. */
export const STAFF_ROLES: readonly UserRole[] = ["SUPER_ADMIN", "ADMIN", "DISPATCHER"];

export function isStaffRole(role: UserRole): boolean {
  return STAFF_ROLES.includes(role);
}
