import type { Request, Response, NextFunction } from "express";
import { validateUuidParam } from "../../middleware/request-validation.js";
import * as service from "./workforce.service.js";
import { createQualificationSchema, createShiftSchema, qualificationListQuerySchema, shiftListQuerySchema, updateAvailabilitySchema, updateShiftSchema, updateShiftStatusSchema, verifyQualificationSchema } from "./workforce.validation.js";

const actor = (req: Request) => ({ userId: req.user!.id, role: req.user!.role });
function uuid(req: Request, res: Response, name: string, label: string) { return validateUuidParam(req, res, label, name); }

export async function updateAvailability(req: Request, res: Response, next: NextFunction) {
  try { const id = uuid(req, res, "id", "Driver"); if (!id) return; const { availability } = updateAvailabilitySchema.parse(req.body); const data = await service.updateDriverAvailability(id, availability, actor(req)); res.status(200).json({ success: true, data }); } catch (error) { next(error); }
}
export async function listQualifications(req: Request, res: Response, next: NextFunction) {
  try { const id = uuid(req, res, "id", "Driver"); if (!id) return; const result = await service.listQualifications(id, qualificationListQuerySchema.parse(req.query)); res.status(200).json({ success: true, data: result.qualifications, pagination: result.pagination }); } catch (error) { next(error); }
}
export async function createQualification(req: Request, res: Response, next: NextFunction) {
  try { const id = uuid(req, res, "id", "Driver"); if (!id) return; const data = await service.createQualification(id, createQualificationSchema.parse(req.body), actor(req)); res.status(201).json({ success: true, data }); } catch (error) { next(error); }
}
export async function verifyQualification(req: Request, res: Response, next: NextFunction) {
  try { const id = uuid(req, res, "id", "Driver"); if (!id) return; const qualificationId = uuid(req, res, "qualificationId", "Qualification"); if (!qualificationId) return; const { status } = verifyQualificationSchema.parse(req.body); const data = await service.verifyQualification(id, qualificationId, status, actor(req)); res.status(200).json({ success: true, data }); } catch (error) { next(error); }
}
export async function listShifts(req: Request, res: Response, next: NextFunction) {
  try { const id = uuid(req, res, "id", "Driver"); if (!id) return; const result = await service.listDriverShifts(id, shiftListQuerySchema.parse(req.query)); res.status(200).json({ success: true, data: result.shifts, pagination: result.pagination }); } catch (error) { next(error); }
}
export async function createShift(req: Request, res: Response, next: NextFunction) {
  try { const id = uuid(req, res, "id", "Driver"); if (!id) return; const data = await service.createDriverShift(id, createShiftSchema.parse(req.body), actor(req)); res.status(201).json({ success: true, data }); } catch (error) { next(error); }
}
export async function updateShift(req: Request, res: Response, next: NextFunction) {
  try { const id = uuid(req, res, "id", "Driver"); if (!id) return; const shiftId = uuid(req, res, "shiftId", "Shift"); if (!shiftId) return; const data = await service.updateDriverShift(id, shiftId, updateShiftSchema.parse(req.body), actor(req)); res.status(200).json({ success: true, data }); } catch (error) { next(error); }
}
export async function updateShiftStatus(req: Request, res: Response, next: NextFunction) {
  try { const id = uuid(req, res, "id", "Driver"); if (!id) return; const shiftId = uuid(req, res, "shiftId", "Shift"); if (!shiftId) return; const { status } = updateShiftStatusSchema.parse(req.body); const data = await service.updateDriverShiftStatus(id, shiftId, status, actor(req)); res.status(200).json({ success: true, data }); } catch (error) { next(error); }
}
