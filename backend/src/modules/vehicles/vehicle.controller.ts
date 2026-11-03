import type { Request, Response, NextFunction } from "express";
import { validateUuidParam } from "../../middleware/request-validation.js";
import * as service from "./vehicle.service.js";
import { assignVehicleSchema, assignmentHistoryQuerySchema, createVehicleSchema, updateVehicleSchema, updateVehicleStatusSchema, vehicleListQuerySchema } from "./vehicle.validation.js";

const actor = (req: Request) => ({ userId: req.user!.id, role: req.user!.role });
function uuid(req: Request, res: Response, name = "id", label = "Vehicle") {
  return validateUuidParam(req, res, label, name);
}

export async function createVehicle(req: Request, res: Response, next: NextFunction) {
  try { const data = await service.createVehicle(createVehicleSchema.parse(req.body), actor(req)); res.status(201).json({ success: true, message: "Vehicle created successfully.", data }); } catch (error) { next(error); }
}
export async function listVehicles(req: Request, res: Response, next: NextFunction) {
  try { const result = await service.listVehicles(vehicleListQuerySchema.parse(req.query)); res.status(200).json({ success: true, data: result.vehicles, pagination: result.pagination }); } catch (error) { next(error); }
}
export async function getVehicle(req: Request, res: Response, next: NextFunction) {
  try {
    const id = validateUuidParam(req, res, "Vehicle"); if (!id) return;
    const data = await service.getVehicle(id);
    if (!data) return res.status(404).json({ success: false, code: "NOT_FOUND", message: "Vehicle not found." });
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
}
export async function listAssignments(req: Request, res: Response, next: NextFunction) {
  try { const id = uuid(req, res); if (!id) return; const filters = assignmentHistoryQuerySchema.parse(req.query); const result = await service.listVehicleAssignments(id, filters.page, filters.limit); res.status(200).json({ success: true, data: result.assignments, pagination: result.pagination }); } catch (error) { next(error); }
}
export async function updateVehicle(req: Request, res: Response, next: NextFunction) {
  try { const id = validateUuidParam(req, res, "Vehicle"); if (!id) return; const data = await service.updateVehicle(id, updateVehicleSchema.parse(req.body), actor(req)); res.status(200).json({ success: true, data }); } catch (error) { next(error); }
}
export async function updateVehicleStatus(req: Request, res: Response, next: NextFunction) {
  try { const id = validateUuidParam(req, res, "Vehicle"); if (!id) return; const { status } = updateVehicleStatusSchema.parse(req.body); const data = await service.updateVehicleStatus(id, status, actor(req)); res.status(200).json({ success: true, data }); } catch (error) { next(error); }
}
export async function assignVehicle(req: Request, res: Response, next: NextFunction) {
  try { const id = validateUuidParam(req, res, "Vehicle"); if (!id) return; const { driverId } = assignVehicleSchema.parse(req.body); const data = await service.assignVehicleToDriver(id, driverId, actor(req)); res.status(200).json({ success: true, data }); } catch (error) { next(error); }
}
export async function unassignVehicle(req: Request, res: Response, next: NextFunction) {
  try { const id = validateUuidParam(req, res, "Vehicle"); if (!id) return; const data = await service.unassignVehicleFromDriver(id, actor(req)); res.status(200).json({ success: true, data }); } catch (error) { next(error); }
}
