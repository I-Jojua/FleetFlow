import argon2 from "argon2";
import { prisma } from "../../config/prisma";
import type {
  CreateCustomerInput,
  UpdateCustomerInput,
  CustomerQueryInput,
} from "./customer.validation";
import { AuditOutcome, type UserRole } from "../../generated/prisma/client.js";
import { writeAuditEvent } from "../audit/audit.service.js";

export async function createCustomer(data: CreateCustomerInput, actor?: { userId: string; role: UserRole }) {
  const passwordHash = await argon2.hash(data.password, {
    type: argon2.argon2id,
  });

  return prisma.$transaction(async (tx) => {
    const customer = await tx.user.create({
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone ?? null,
        passwordHash,
        role: "CUSTOMER",
        status: "ACTIVE",
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });
    await writeAuditEvent(tx, {
      actor,
      action: "customers.create",
      resourceType: "customer",
      resourceId: customer.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { newRole: "CUSTOMER", newStatus: "ACTIVE" },
      captureIpAddress: true,
    });
    return customer;
  });
}

export async function getAllCustomers(filters: CustomerQueryInput) {
  const { search, status, page, limit } = filters;

  const where = {
    role: "CUSTOMER" as const,
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
            { phone: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const skip = (page - 1) * limit;

  const [customers, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
        createdAt: true,
        _count: {
          select: {
            customerDeliveries: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    customers,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1,
    },
  };
}

export async function getCustomerById(id: string) {
  return prisma.user.findFirst({
    where: {
      id,
      role: "CUSTOMER",
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      customerDeliveries: {
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          trackingCode: true,
          status: true,
          recipientName: true,
          deliveryAddress: true,
          createdAt: true,
        },
      },
      _count: {
        select: {
          customerDeliveries: true,
        },
      },
    },
  });
}

export async function updateCustomer(id: string, data: UpdateCustomerInput, actor?: { userId: string; role: UserRole }) {
  return prisma.$transaction(async (tx) => {
    const customer = await tx.user.findFirst({
      where: { id, role: "CUSTOMER" },
      select: { id: true },
    });
    if (!customer) throw new Error("CUSTOMER_NOT_FOUND");

    const updated = await tx.user.update({
      where: { id },
      data,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
        updatedAt: true,
      },
    });
    await writeAuditEvent(tx, {
      actor,
      action: "customers.update",
      resourceType: "customer",
      resourceId: id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { changedFields: Object.keys(data) },
      captureIpAddress: true,
    });
    return updated;
  });
}

export async function updateCustomerStatus(
  id: string,
  status: "ACTIVE" | "INACTIVE" | "SUSPENDED" | "PENDING_VERIFICATION",
  actor?: { userId: string; role: UserRole },
) {
  return prisma.$transaction(async (tx) => {
    const customer = await tx.user.findFirst({
      where: { id, role: "CUSTOMER" },
      select: { id: true, status: true },
    });
    if (!customer) throw new Error("CUSTOMER_NOT_FOUND");

    const updated = await tx.user.update({
      where: { id },
      data: { status },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
      },
    });
    await writeAuditEvent(tx, {
      actor,
      action: "customers.status_update",
      resourceType: "customer",
      resourceId: id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { previousStatus: customer.status, newStatus: updated.status },
      captureIpAddress: true,
    });
    return updated;
  });
}

export async function getCustomerStatistics(id: string) {
  const customer = await prisma.user.findFirst({
    where: { id, role: "CUSTOMER" },
    select: {
      id: true,
      firstName: true,
      lastName: true,
    },
  });

  if (!customer) {
    throw new Error("CUSTOMER_NOT_FOUND");
  }

  const [
    total,
    pending,
    assigned,
    pickedUp,
    inTransit,
    delivered,
    cancelled,
  ] = await Promise.all([
    prisma.delivery.count({ where: { customerId: id } }),
    prisma.delivery.count({ where: { customerId: id, status: "PENDING" } }),
    prisma.delivery.count({ where: { customerId: id, status: "ASSIGNED" } }),
    prisma.delivery.count({ where: { customerId: id, status: "PICKED_UP" } }),
    prisma.delivery.count({ where: { customerId: id, status: "IN_TRANSIT" } }),
    prisma.delivery.count({ where: { customerId: id, status: "DELIVERED" } }),
    prisma.delivery.count({ where: { customerId: id, status: "CANCELLED" } }),
  ]);

  return {
    customer,
    deliveries: {
      total,
      pending,
      assigned,
      pickedUp,
      inTransit,
      delivered,
      cancelled,
    },
  };
}
